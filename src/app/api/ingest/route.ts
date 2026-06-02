import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db/client";
import {
  usageSnapshots,
  usageCurrentState,
  toolInstances,
  toolQuotaAttributions,
  quotaPools,
  agentHeartbeats,
} from "@/lib/db/schema";
import { validateDeviceToken } from "@/lib/devices";
import { eq, and, sql } from "drizzle-orm";
import { serializeDbError, normalizeSnapshot, findInvalidUUIDs } from "@/lib/ingest-normalize";

// ── Zod Schemas ────────────────────────────────────────────────

const quotaPoolSnapshotSchema = z.object({
  quotaPoolId: z.string().uuid(),
  windowName: z.string().min(1).max(128),
  usageAmount: z.number().finite(),
  windowStart: z.coerce.date(),
  windowEnd: z.coerce.date(),
  idempotencyKey: z.string().min(1).max(255),
  source: z.string().default("heartbeat"),
  confidence: z.number().min(0).max(1).default(1),
});

const toolQuotaAttributionSchema = z.object({
  toolInstanceFingerprint: z.string().min(1).max(255),
  quotaPoolId: z.string().uuid(),
  allocatedAmount: z.number().finite(),
});

const toolInfoSchema = z.object({
  toolType: z.string().min(1).max(128),
  displayName: z.string().max(255).optional(),
  agentFingerprint: z.string().min(1).max(255),
  metadata: z.string().optional(),
});

const deviceInfoSchema = z.object({
  deviceFingerprint: z.string().min(1).max(255),
  agentVersion: z.string().max(64).optional(),
  os: z.string().max(64).optional(),
});

const ingestPayloadSchema = z.object({
  quotaPoolSnapshots: z.array(quotaPoolSnapshotSchema).default([]),
  toolQuotaAttributions: z.array(toolQuotaAttributionSchema).default([]),
  toolInfos: z.array(toolInfoSchema).default([]),
  device: deviceInfoSchema,
});

// ── Ingest Handler ─────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    // ── Auth ─────────────────────────────────────────────────
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return NextResponse.json(
        { error: "Missing or invalid Authorization header" },
        { status: 401 },
      );
    }

    const token = authHeader.slice("Bearer ".length).trim();
    if (!token) {
      return NextResponse.json(
        { error: "Missing token in Authorization header" },
        { status: 401 },
      );
    }

    const device = await validateDeviceToken(token);
    if (!device) {
      return NextResponse.json(
        { error: "Invalid device token" },
        { status: 401 },
      );
    }

    const { workspaceId, deviceId } = device;

    // ── Parse & Validate Body ────────────────────────────────
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body" },
        { status: 400 },
      );
    }

    const parseResult = ingestPayloadSchema.safeParse(body);
    if (!parseResult.success) {
      const issues = parseResult.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      }));
      return NextResponse.json(
        { error: "Invalid payload", details: issues },
        { status: 400 },
      );
    }

    const payload = parseResult.data;

    // ── Validate device fingerprint ─────────────────────────
    if (payload.device.deviceFingerprint.length === 0) {
      return NextResponse.json(
        { error: "device.deviceFingerprint is required" },
        { status: 400 },
      );
    }

    // ── Pre-validate all UUIDs ──────────────────────────────
    const allPoolIds = [
      ...payload.quotaPoolSnapshots.map((s) => s.quotaPoolId),
      ...payload.toolQuotaAttributions.map((a) => a.quotaPoolId),
    ];
    const badUuids = findInvalidUUIDs(allPoolIds);
    if (badUuids.length > 0) {
      return NextResponse.json(
        { error: `Invalid UUID values: ${badUuids.join(", ")}` },
        { status: 400 },
      );
    }

    // ── Normalize numeric values ────────────────────────────
    for (const snap of payload.quotaPoolSnapshots) {
      const normalized = normalizeSnapshot(snap);
      if (typeof normalized === "string") {
        return NextResponse.json({ error: normalized }, { status: 400 });
      }
      // Mutate in place with string values for the DB
      (snap as Record<string, unknown>).usageAmount = normalized.usageAmount;
      (snap as Record<string, unknown>).confidence = normalized.confidence;
    }

    // ── Begin Transaction ────────────────────────────────────
    // We use individual DB calls within the transaction.
    // Drizzle's postgres-js driver supports transactions via db.transaction().

    await db.transaction(async (tx) => {
      // ── Verify workspace has the referenced quota pools ────
      const poolIds = [
        ...new Set([
          ...payload.quotaPoolSnapshots.map((s) => s.quotaPoolId),
          ...payload.toolQuotaAttributions.map((a) => a.quotaPoolId),
        ]),
      ];

      if (poolIds.length > 0) {
        const existingPools = await tx
          .select({ id: quotaPools.id })
          .from(quotaPools)
          .where(
            and(
              eq(quotaPools.workspaceId, workspaceId),
              sql`${quotaPools.id} = ANY(${sql.raw(`ARRAY[${poolIds.map((id) => `'${id}'::uuid`).join(",")}]`)})`,
            ),
          );

        const existingPoolIds = new Set(existingPools.map((p) => p.id));
        const invalidPools = poolIds.filter((id) => !existingPoolIds.has(id));
        if (invalidPools.length > 0) {
          throw new IngestError(
            `Referenced quota pools not found in workspace: ${invalidPools.join(", ")}`,
            400,
          );
        }
      }

      // ── Upsert Usage Snapshots (idempotent) ───────────────
      for (const snap of payload.quotaPoolSnapshots) {
        await tx
          .insert(usageSnapshots)
          .values({
            workspaceId,
            quotaPoolId: snap.quotaPoolId,
            usageAmount: String(snap.usageAmount),
            windowName: snap.windowName,
            snapshotWindowStart: snap.windowStart,
            snapshotWindowEnd: snap.windowEnd,
            idempotencyKey: snap.idempotencyKey,
            source: snap.source,
            confidence: String(snap.confidence),
          })
          .onConflictDoNothing({
            target: usageSnapshots.idempotencyKey,
          });
      }

      // ── Upsert Usage Current State ────────────────────────
      for (const snap of payload.quotaPoolSnapshots) {
        await tx
          .insert(usageCurrentState)
          .values({
            workspaceId,
            quotaPoolId: snap.quotaPoolId,
            windowName: snap.windowName,
            usageAmount: String(snap.usageAmount),
            windowStart: snap.windowStart,
            windowEnd: snap.windowEnd,
          })
          .onConflictDoUpdate({
            target: [
              usageCurrentState.workspaceId,
              usageCurrentState.quotaPoolId,
              usageCurrentState.windowName,
            ],
            set: {
              usageAmount: String(snap.usageAmount),
              windowStart: snap.windowStart,
              windowEnd: snap.windowEnd,
              lastUpdatedAt: new Date(),
            },
          });
      }

      // ── Upsert Tool Instances ─────────────────────────────
      const toolFingerprints = new Set<string>();
      const toolInstanceIdMap = new Map<string, string>();

      for (const tool of payload.toolInfos) {
        // Use the agentFingerprint + toolType as a composite fingerprint to deduplicate
        // We'll store deviceFingerprint as metadata for now
        const meta = tool.metadata
          ? (() => {
              try {
                return JSON.stringify({
                  ...JSON.parse(tool.metadata),
                  deviceFingerprint: payload.device.deviceFingerprint,
                  deviceId,
                });
              } catch {
                return JSON.stringify({
                  raw: tool.metadata,
                  deviceFingerprint: payload.device.deviceFingerprint,
                  deviceId,
                });
              }
            })()
          : JSON.stringify({
              deviceFingerprint: payload.device.deviceFingerprint,
              deviceId,
            });

        const fingerprint = `${tool.agentFingerprint}::${tool.toolType}`;
        if (toolFingerprints.has(fingerprint)) continue;
        toolFingerprints.add(fingerprint);

        // Find existing tool instance by agent_fingerprint + tool_type
        const [existing] = await tx
          .select({ id: toolInstances.id })
          .from(toolInstances)
          .where(
            and(
              eq(toolInstances.workspaceId, workspaceId),
              eq(toolInstances.toolType, tool.toolType),
              eq(toolInstances.agentFingerprint, tool.agentFingerprint),
            ),
          )
          .limit(1);

        if (existing) {
          // Update lastHeartbeatAt and metadata
          await tx
            .update(toolInstances)
            .set({
              displayName: tool.displayName ?? undefined,
              metadata: meta,
              lastHeartbeatAt: new Date(),
              isActive: true,
            })
            .where(eq(toolInstances.id, existing.id));
          toolInstanceIdMap.set(fingerprint, existing.id);
        } else {
          const [created] = await tx
            .insert(toolInstances)
            .values({
              workspaceId,
              toolType: tool.toolType,
              displayName: tool.displayName ?? tool.toolType,
              agentFingerprint: tool.agentFingerprint,
              metadata: meta,
              isActive: true,
              lastHeartbeatAt: new Date(),
            })
            .returning({ id: toolInstances.id });
          toolInstanceIdMap.set(fingerprint, created.id);
        }
      }

      // ── Upsert Tool Quota Attributions ────────────────────
      for (const attr of payload.toolQuotaAttributions) {
        // We need to find the tool instance ID from the fingerprint
        // The toolQuotaAttribution uses toolInstanceFingerprint which maps
        // to agentFingerprint::toolType
        // Find the matching tool instance in this transaction
        const [toolInstance] = await tx
          .select({ id: toolInstances.id })
          .from(toolInstances)
          .where(
            and(
              eq(toolInstances.workspaceId, workspaceId),
              eq(
                toolInstances.agentFingerprint,
                attr.toolInstanceFingerprint,
              ),
            ),
          )
          .limit(1);

        if (!toolInstance) {
          throw new IngestError(
            `Tool instance not found for fingerprint: ${attr.toolInstanceFingerprint}. Send toolInfos first.`,
            400,
          );
        }

        await tx
          .insert(toolQuotaAttributions)
          .values({
            toolInstanceId: toolInstance.id,
            quotaPoolId: attr.quotaPoolId,
            allocatedAmount: String(attr.allocatedAmount),
          })
          .onConflictDoUpdate({
            target: [
              toolQuotaAttributions.toolInstanceId,
              toolQuotaAttributions.quotaPoolId,
            ],
            set: {
              allocatedAmount: String(attr.allocatedAmount),
            },
          });
      }

      // ── Create Agent Heartbeat ────────────────────────────
      // For each toolInfo, record a heartbeat
      for (const tool of payload.toolInfos) {
        await tx.insert(agentHeartbeats).values({
          workspaceId,
          agentFingerprint: tool.agentFingerprint,
          toolType: tool.toolType,
          deviceFingerprint: payload.device.deviceFingerprint,
          metadata: tool.metadata ?? null,
          heartbeatAt: new Date(),
        });
      }

      // If no toolInfos but we have snapshots, record a generic heartbeat
      if (payload.toolInfos.length === 0 && payload.quotaPoolSnapshots.length > 0) {
        await tx.insert(agentHeartbeats).values({
          workspaceId,
          agentFingerprint: payload.device.deviceFingerprint,
          toolType: "unknown",
          deviceFingerprint: payload.device.deviceFingerprint,
          heartbeatAt: new Date(),
        });
      }

      // ── Update device lastSeenAt ─────────────────────────
      const { devices } = await import("@/lib/db/schema");
      await tx
        .update(devices)
        .set({
          lastSeenAt: new Date(),
          agentVersion: payload.device.agentVersion ?? undefined,
          os: payload.device.os ?? undefined,
        })
        .where(eq(devices.id, deviceId));
    });

    return NextResponse.json({
      success: true,
      message: "Ingest processed successfully",
    });
  } catch (error) {
    if (error instanceof IngestError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.statusCode },
      );
    }
    const message =
      error instanceof Error ? error.message : "Internal server error";
    const dbErr = serializeDbError(error);
    return NextResponse.json(
      {
        error: message,
        ...(process.env.DEBUG_INGEST_ERRORS === "true"
          ? { db: dbErr }
          : { db: { code: dbErr.code, detail: dbErr.detail, constraint: dbErr.constraint, table: dbErr.table } }),
      },
      { status: 500 },
    );
  }
}

// ── Custom Error ───────────────────────────────────────────────

class IngestError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "IngestError";
    this.statusCode = statusCode;
  }
}
