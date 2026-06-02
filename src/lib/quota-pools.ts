import { db } from "./db/client";
import {
  quotaPools,
  usageCurrentState,
  usageSnapshots,
  agentHeartbeats,
  workspaces,
} from "./db/schema";
import { eq, desc } from "drizzle-orm";

// ── Usage Window Type ─────────────────────────────────────────

export type UsageWindow = {
  usageAmount: string;
  windowName: string;
  windowStart: Date;
  windowEnd: Date;
  lastUpdatedAt: Date;
  source?: string | null;
  confidence?: string | null;
  /** True if data >30 min old or never updated */
  isStale: boolean;
  /** Human-readable age, e.g. "2 min ago" */
  ageLabel: string;
};

// ── Pool Types ────────────────────────────────────────────────

export type QuotaPoolWithUsage = {
  id: string;
  workspaceId: string;
  kind: string;
  accountFingerprint: string;
  displayName: string;
  totalAllocated: string;
  rolloverPolicy: string;
  rolloverCap: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** All usage windows (one per window_name). May be empty. */
  usageWindows: UsageWindow[];
  /** Most recently updated window, or null. Backward compat. */
  usageCurrent: UsageWindow | null;
  /** Computed data mode for the data proof card */
  dataMode: "demo" | "real" | "manual" | "detected_only" | "unknown";
};

export type GetQuotaPoolsResponse = {
  pools: QuotaPoolWithUsage[];
  workspace: { id: string; name: string; slug: string };
  /** Data freshness metadata for the proof card */
  freshness: {
    dataMode: string;
    deviceCount: number;
    latestReceivedAt: string | null;
    latestCollectedAt: string | null;
    staleWindowCount: number;
    totalWindows: number;
    sources: string[];
    dashboardRenderedAt: string;
  };
};

// ── Age and Stale Helpers ─────────────────────────────────────

function ageLabel(dateStr: Date | string | null | undefined): string {
  if (!dateStr) return "Never";
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

function isStale(dateStr: Date | string | null | undefined, maxMin = 30): boolean {
  if (!dateStr) return true;
  return Date.now() - new Date(dateStr).getTime() > maxMin * 60 * 1000;
}

function computeDataMode(
  devices: unknown[],
  pools: QuotaPoolWithUsage[],
  isDemoSeed: boolean,
): "demo" | "real" | "manual" | "detected_only" | "unknown" {
  if (devices.length === 0) {
    // No real devices — check if seed data
    if (isDemoSeed) return "demo";
    return "unknown";
  }

  // Check if any pool has manual source
  for (const pool of pools) {
    for (const w of pool.usageWindows) {
      if (w.source === "manual" || w.source === "manual_opencode_go") return "manual";
    }
  }

  // Check if any pool has a system/confirmed source
  const nonDetected: string[] = [];
  for (const pool of pools) {
    for (const w of pool.usageWindows) {
      if (w.source && w.source !== "detected" && w.source !== "heartbeat") {
        nonDetected.push(w.source);
      }
    }
  }
  if (nonDetected.length > 0) return "real";

  // Device exists but only detection windows
  for (const pool of pools) {
    if (pool.usageWindows.length > 0) return "detected_only";
  }

  return "unknown";
}

// ── Data Access ────────────────────────────────────────────────

export async function getQuotaPoolsForWorkspace(
  workspaceId: string,
): Promise<GetQuotaPoolsResponse> {
  const [ws] = await db
    .select({ id: workspaces.id, name: workspaces.name, slug: workspaces.slug })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  if (!ws) throw new Error(`Workspace not found: ${workspaceId}`);

  const pools = await db
    .select()
    .from(quotaPools)
    .where(eq(quotaPools.workspaceId, workspaceId))
    .orderBy(quotaPools.displayName);

  const poolIds = pools.map((p) => p.id);

  // Get ALL usage_current_state rows (not just latest per pool)
  const states = poolIds.length > 0
    ? await db.select().from(usageCurrentState)
        .where(eq(usageCurrentState.workspaceId, workspaceId))
        .orderBy(desc(usageCurrentState.lastUpdatedAt))
    : [];

  // Get usage_snapshots for source/confidence metadata
  const srcData = poolIds.length > 0
    ? await db.select({
        quotaPoolId: usageSnapshots.quotaPoolId,
        windowName: usageSnapshots.windowName,
        source: usageSnapshots.source,
        confidence: usageSnapshots.confidence,
      }).from(usageSnapshots)
        .where(eq(usageSnapshots.workspaceId, workspaceId))
        .orderBy(desc(usageSnapshots.capturedAt))
    : [];

  // Source/confidence map: key = poolId::windowName
  const srcMap = new Map<string, { source: string | null; confidence: string | null }>();
  for (const s of srcData) {
    const key = `${s.quotaPoolId}::${s.windowName}`;
    if (!srcMap.has(key)) srcMap.set(key, { source: s.source, confidence: s.confidence });
  }

  // Group current states by pool
  const byPool = new Map<string, typeof states>();
  for (const s of states) {
    if (!byPool.has(s.quotaPoolId)) byPool.set(s.quotaPoolId, []);
    byPool.get(s.quotaPoolId)!.push(s);
  }

  // Compute device count for data mode
  const { devices: devicesTable } = await import("./db/schema");
  const deviceRows = poolIds.length > 0
    ? await db.select({ id: devicesTable.id }).from(devicesTable)
        .where(eq(devicesTable.workspaceId, workspaceId))
    : [];
  const deviceCount = deviceRows.length;

  const poolsWithUsage: QuotaPoolWithUsage[] = pools.map((pool) => {
    const windows = byPool.get(pool.id) ?? [];
    const usageWindows: UsageWindow[] = windows.map((w) => {
      const meta = srcMap.get(`${pool.id}::${w.windowName}`);
      return {
        usageAmount: w.usageAmount,
        windowName: w.windowName,
        windowStart: w.windowStart,
        windowEnd: w.windowEnd,
        lastUpdatedAt: w.lastUpdatedAt,
        source: meta?.source ?? null,
        confidence: meta?.confidence ?? null,
        isStale: isStale(w.lastUpdatedAt),
        ageLabel: ageLabel(w.lastUpdatedAt),
      };
    });
    usageWindows.sort((a, b) => a.windowName.localeCompare(b.windowName));

    return {
      id: pool.id,
      workspaceId: pool.workspaceId,
      kind: pool.kind,
      accountFingerprint: pool.accountFingerprint,
      displayName: pool.displayName,
      totalAllocated: pool.totalAllocated,
      rolloverPolicy: pool.rolloverPolicy,
      rolloverCap: pool.rolloverCap,
      createdAt: pool.createdAt,
      updatedAt: pool.updatedAt,
      usageWindows,
      usageCurrent: usageWindows.length > 0 ? usageWindows[usageWindows.length - 1] : null,
      dataMode: "unknown" as const,
    };
  });

  // Fetch latest heartbeat for freshness
  const latestHeartbeat = poolIds.length > 0
    ? (await db.select({ heartbeatAt: agentHeartbeats.heartbeatAt })
        .from(agentHeartbeats)
        .where(eq(agentHeartbeats.workspaceId, workspaceId))
        .orderBy(desc(agentHeartbeats.heartbeatAt))
        .limit(1))[0] ?? null
    : null;

  // Compute all sources across all windows
  const allSources = new Set<string>();
  for (const pool of poolsWithUsage) {
    for (const w of pool.usageWindows) {
      if (w.source) allSources.add(w.source);
    }
  }

  // Compute latest received timestamp from usage_current_state
  const latestReceived = states.length > 0
    ? states.reduce((latest, s) =>
        new Date(s.lastUpdatedAt) > new Date(latest) ? s.lastUpdatedAt : latest,
        states[0].lastUpdatedAt)
    : null;

  const isDemoSeed = false; // Computed client-side via computeIsDemoSeed
  const dataMode = computeDataMode(deviceRows, poolsWithUsage, isDemoSeed);

  // Apply computed data modes to each pool
  for (const pool of poolsWithUsage) {
    pool.dataMode = dataMode;
  }

  return {
    pools: poolsWithUsage,
    workspace: { id: ws.id, name: ws.name, slug: ws.slug },
    freshness: {
      dataMode,
      deviceCount,
      latestReceivedAt: latestReceived ? new Date(latestReceived).toISOString() : null,
      latestCollectedAt: latestHeartbeat ? new Date(latestHeartbeat.heartbeatAt).toISOString() : null,
      staleWindowCount: poolsWithUsage.reduce(
        (count, p) => count + p.usageWindows.filter((w) => w.isStale).length, 0,
      ),
      totalWindows: poolsWithUsage.reduce(
        (count, p) => count + p.usageWindows.length, 0,
      ),
      sources: [...allSources].sort(),
      dashboardRenderedAt: new Date().toISOString(),
    },
  };
}
