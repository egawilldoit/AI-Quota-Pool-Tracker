import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db/client";
import {
  manualUsageEntries,
  usageSnapshots,
  usageCurrentState,
  quotaPools,
  workspaces,
} from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

// ── Zod Schemas ────────────────────────────────────────────────

const manualUsageSchema = z.object({
  quotaPoolId: z.string().uuid(),
  usageAmount: z.number().finite(),
  description: z.string().max(500).optional(),
  resetTime: z.coerce.date().optional(),
});

// ── Handler ────────────────────────────────────────────────────

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const { workspaceId } = await params;

    // ── Verify workspace exists ──────────────────────────────
    const [workspace] = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);

    if (!workspace) {
      return NextResponse.json(
        { error: "Workspace not found" },
        { status: 404 },
      );
    }

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

    const parseResult = manualUsageSchema.safeParse(body);
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

    // ── Validate the quota pool exists (or create it) ───────
    const [existingPool] = await db
      .select()
      .from(quotaPools)
      .where(
        and(
          eq(quotaPools.id, payload.quotaPoolId),
          eq(quotaPools.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    let pool = existingPool;

    // If quota pool does not exist, create it as an OpenCode Go pool
    if (!pool) {
      // Check if it might belong to another workspace
      const [otherWorkspacePool] = await db
        .select({ id: quotaPools.id })
        .from(quotaPools)
        .where(eq(quotaPools.id, payload.quotaPoolId))
        .limit(1);

      if (otherWorkspacePool) {
        return NextResponse.json(
          { error: "Quota pool belongs to a different workspace" },
          { status: 400 },
        );
      }

      // Create a new OpenCode Go quota pool with a default totalAllocated of 100
      const [createdPool] = await db
        .insert(quotaPools)
        .values({
          id: payload.quotaPoolId,
          workspaceId,
          kind: "credits",
          accountFingerprint: "opencode-go-manual",
          displayName: "OpenCode Go (Manual)",
          totalAllocated: "100",
          rolloverPolicy: "none",
        })
        .returning();

      pool = createdPool;
    }

    // ── Validate usageAmount against totalAllocated ─────────
    const totalAllocated = Number(pool.totalAllocated);
    if (totalAllocated <= 0) {
      return NextResponse.json(
        {
          error: "Quota pool has no allocated capacity",
          details: [{ path: "usageAmount", message: "totalAllocated must be greater than 0" }],
        },
        { status: 400 },
      );
    }

    if (payload.usageAmount < 0) {
      return NextResponse.json(
        {
          error: "Invalid usage amount",
          details: [{ path: "usageAmount", message: "Usage amount cannot be negative" }],
        },
        { status: 400 },
      );
    }

    if (payload.usageAmount > totalAllocated) {
      return NextResponse.json(
        {
          error: "Invalid usage amount",
          details: [
            {
              path: "usageAmount",
              message: `Usage amount (${payload.usageAmount}) exceeds total allocated (${totalAllocated})`,
            },
          ],
        },
        { status: 400 },
      );
    }

    // ── Compute window boundaries ───────────────────────────
    const now = new Date();
    const windowStart = payload.resetTime
      ? new Date(
          payload.resetTime.getTime() -
            (now.getTime() - payload.resetTime.getTime()),
        )
      : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0); // start of day

    const windowEnd = payload.resetTime ?? now;

    const windowName = `manual-${now.toISOString().slice(0, 16).replace("T", "-")}`;

    // ── Execute transaction ──────────────────────────────────
    const result = await db.transaction(async (tx) => {
      // 1. Insert the manual usage entry
      const [entry] = await tx
        .insert(manualUsageEntries)
        .values({
          workspaceId,
          quotaPoolId: payload.quotaPoolId,
          usageAmount: String(payload.usageAmount),
          description: payload.description ?? null,
          enteredBy: "dashboard-user",
          enteredAt: now,
        })
        .returning();

      // 2. Create a usage snapshot (source = "manual", confidence = 0.7)
      const idempotencyKey = `manual-${workspaceId}-${payload.quotaPoolId}-${now.getTime()}`;

      await tx
        .insert(usageSnapshots)
        .values({
          workspaceId,
          quotaPoolId: payload.quotaPoolId,
          usageAmount: String(payload.usageAmount),
          windowName,
          snapshotWindowStart: windowStart,
          snapshotWindowEnd: windowEnd,
          idempotencyKey,
          source: "manual",
          confidence: "0.700",
        })
        .onConflictDoNothing({
          target: usageSnapshots.idempotencyKey,
        });

      // 3. Upsert the current usage state
      await tx
        .insert(usageCurrentState)
        .values({
          workspaceId,
          quotaPoolId: payload.quotaPoolId,
          windowName,
          usageAmount: String(payload.usageAmount),
          windowStart,
          windowEnd,
        })
        .onConflictDoUpdate({
          target: [
            usageCurrentState.workspaceId,
            usageCurrentState.quotaPoolId,
            usageCurrentState.windowName,
          ],
          set: {
            usageAmount: String(payload.usageAmount),
            windowStart,
            windowEnd,
            lastUpdatedAt: new Date(),
          },
        });

      return { entry };
    });

    // ── Return updated pool state ───────────────────────────
    return NextResponse.json({
      success: true,
      message: "Manual usage recorded successfully",
      usageEntry: {
        id: result.entry.id,
        usageAmount: result.entry.usageAmount,
        description: result.entry.description,
        enteredBy: result.entry.enteredBy,
        enteredAt: result.entry.enteredAt,
      },
      quotaPool: {
        id: pool.id,
        displayName: pool.displayName,
        kind: pool.kind,
        totalAllocated: pool.totalAllocated,
        usageAmount: String(payload.usageAmount),
        usagePercentage: Math.round((payload.usageAmount / totalAllocated) * 100),
        source: "manual",
        confidence: "0.700",
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
