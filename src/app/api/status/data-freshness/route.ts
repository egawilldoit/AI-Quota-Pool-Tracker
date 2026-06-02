/**
 * GET /api/status/data-freshness
 *
 * Returns sanitized freshness metadata about the dashboard data pipeline.
 * NEVER returns: tokens, device token hashes, env vars, raw payloads,
 * headers, cookies, or any sensitive server state.
 *
 * This endpoint helps CLI `verify` and the dashboard Data Freshness card
 * confirm that real, live data is flowing through the system.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import {
  workspaces,
  usageSnapshots,
  usageCurrentState,
  agentHeartbeats,
  devices,
} from "@/lib/db/schema";
import { eq, desc, sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    // Use the first workspace (single-tenant in MVP)
    const [ws] = await db
      .select({ id: workspaces.id, name: workspaces.name, slug: workspaces.slug })
      .from(workspaces)
      .limit(1);

    if (!ws) {
      return NextResponse.json({
        mode: "empty",
        message: "No workspace configured yet.",
        workspaceId: null,
        deviceCount: 0,
        currentStateCount: 0,
        latestReceivedAt: null,
        latestCollectedAt: null,
        sources: [],
        staleWindows: [],
        dashboardRenderedAt: new Date().toISOString(),
      });
    }

    const workspaceId = ws.id;

    // Count devices
    const deviceCount = (await db
      .select({ count: sql<number>`count(*)` })
      .from(devices)
      .where(eq(devices.workspaceId, workspaceId)))[0]?.count ?? 0;

    // Count current state rows
    const currentStateCount = (await db
      .select({ count: sql<number>`count(*)` })
      .from(usageCurrentState)
      .where(eq(usageCurrentState.workspaceId, workspaceId)))[0]?.count ?? 0;

    // Latest snapshot received
    const latestSnapshot = await db
      .select({ capturedAt: usageSnapshots.capturedAt, source: usageSnapshots.source })
      .from(usageSnapshots)
      .where(eq(usageSnapshots.workspaceId, workspaceId))
      .orderBy(desc(usageSnapshots.capturedAt))
      .limit(1);

    // Latest heartbeat
    const latestHeartbeat = await db
      .select({ heartbeatAt: agentHeartbeats.heartbeatAt, toolType: agentHeartbeats.toolType })
      .from(agentHeartbeats)
      .where(eq(agentHeartbeats.workspaceId, workspaceId))
      .orderBy(desc(agentHeartbeats.heartbeatAt))
      .limit(1);

    // Latest current state per pool/window — check for stale
    const allStates = await db
      .select()
      .from(usageCurrentState)
      .where(eq(usageCurrentState.workspaceId, workspaceId))
      .orderBy(desc(usageCurrentState.lastUpdatedAt));

    // All distinct sources
    const sourceRows = await db
      .select({ source: usageSnapshots.source })
      .from(usageSnapshots)
      .where(eq(usageSnapshots.workspaceId, workspaceId))
      .groupBy(usageSnapshots.source);

    const sources = sourceRows.map((r) => r.source).filter(Boolean);

    // Count stale windows (lastUpdatedAt > 30 min ago)
    const staleThreshold = new Date(Date.now() - 30 * 60 * 1000);
    const staleWindows = allStates
      .filter((s) => new Date(s.lastUpdatedAt) < staleThreshold)
      .map((s) => ({
        quotaPoolId: s.quotaPoolId,
        windowName: s.windowName,
        lastUpdatedAt: new Date(s.lastUpdatedAt).toISOString(),
        ageMin: Math.floor((Date.now() - new Date(s.lastUpdatedAt).getTime()) / 60000),
      }));

    // Compute data mode
    let mode: string;
    if (deviceCount === 0) {
      mode = "demo";
    } else if (sources.some((s) => s === "manual" || s === "manual_opencode_go")) {
      mode = "manual";
    } else if (sources.some((s) => s !== "detected" && s !== "heartbeat" && s !== undefined)) {
      mode = "real";
    } else if (sources.includes("detected") || currentStateCount > 0) {
      mode = "detected_only";
    } else {
      mode = "unknown";
    }

    return NextResponse.json({
      workspaceId,
      mode,
      deviceCount,
      currentStateCount,
      latestReceivedAt: latestSnapshot[0]?.capturedAt
        ? new Date(latestSnapshot[0].capturedAt).toISOString()
        : null,
      latestCollectedAt: latestHeartbeat[0]?.heartbeatAt
        ? new Date(latestHeartbeat[0].heartbeatAt).toISOString()
        : null,
      latestSource: latestSnapshot[0]?.source ?? null,
      sources,
      staleWindows,
      staleWindowCount: staleWindows.length,
      dashboardRenderedAt: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to compute freshness",
        message: error instanceof Error ? error.message : "Unknown error",
        dashboardRenderedAt: new Date().toISOString(),
      },
      { status: 500 },
    );
  }
}
