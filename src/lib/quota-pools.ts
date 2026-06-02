import { db } from "./db/client";
import {
  quotaPools,
  usageCurrentState,
  workspaces,
} from "./db/schema";
import { eq, desc } from "drizzle-orm";

// ── Types ──────────────────────────────────────────────────────

export type UsageWindow = {
  usageAmount: string;
  windowName: string;
  windowStart: Date;
  windowEnd: Date;
  lastUpdatedAt: Date;
  source?: string | null;
  confidence?: string | null;
};

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
  /** All usage windows for this pool (one per window_name). May be empty if no data. */
  usageWindows: UsageWindow[];
  /** Convenience: the most recently updated window, or null. Kept for backward compat. */
  usageCurrent: UsageWindow | null;
};

export type GetQuotaPoolsResponse = {
  pools: QuotaPoolWithUsage[];
  workspace: { id: string; name: string; slug: string };
};

// ── Data Access ────────────────────────────────────────────────

/**
 * Fetch all quota pools with current usage state for a workspace.
 */
export async function getQuotaPoolsForWorkspace(
  workspaceId: string,
): Promise<GetQuotaPoolsResponse> {
  const [workspace] = await db
    .select({ id: workspaces.id, name: workspaces.name, slug: workspaces.slug })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }

  const pools = await db
    .select()
    .from(quotaPools)
    .where(eq(quotaPools.workspaceId, workspaceId))
    .orderBy(quotaPools.displayName);

  // Get ALL usage windows for each pool (not just the latest)
  const poolIds = pools.map((p) => p.id);
  const usageStates = poolIds.length > 0
    ? await db
        .select()
        .from(usageCurrentState)
        .where(eq(usageCurrentState.workspaceId, workspaceId))
        .orderBy(desc(usageCurrentState.lastUpdatedAt))
    : [];

  // Also get the latest usage_snapshot per window to get source/confidence
  const { usageSnapshots } = await import("./db/schema");
  const snapshots = poolIds.length > 0
    ? await db
        .select({
          quotaPoolId: usageSnapshots.quotaPoolId,
          windowName: usageSnapshots.windowName,
          source: usageSnapshots.source,
          confidence: usageSnapshots.confidence,
        })
        .from(usageSnapshots)
        .where(eq(usageSnapshots.workspaceId, workspaceId))
        .orderBy(desc(usageSnapshots.capturedAt))
    : [];

  // Build a map of latest source/confidence per (pool, window)
  const sourceMap = new Map<string, { source: string | null; confidence: string | null }>();
  for (const s of snapshots) {
    const key = `${s.quotaPoolId}::${s.windowName}`;
    if (!sourceMap.has(key)) {
      sourceMap.set(key, { source: s.source, confidence: s.confidence });
    }
  }

  // Group usage states by pool
  const usageByPool = new Map<string, typeof usageStates>();
  for (const state of usageStates) {
    if (!usageByPool.has(state.quotaPoolId)) {
      usageByPool.set(state.quotaPoolId, []);
    }
    usageByPool.get(state.quotaPoolId)!.push(state);
  }

  const poolsWithUsage: QuotaPoolWithUsage[] = pools.map((pool) => {
    const windows = usageByPool.get(pool.id) ?? [];
    const usageWindows: UsageWindow[] = windows.map((w) => {
      const srcMeta = sourceMap.get(`${pool.id}::${w.windowName}`);
      return {
        usageAmount: w.usageAmount,
        windowName: w.windowName,
        windowStart: w.windowStart,
        windowEnd: w.windowEnd,
        lastUpdatedAt: w.lastUpdatedAt,
        source: srcMeta?.source ?? null,
        confidence: srcMeta?.confidence ?? null,
      };
    });

    // Sort windows alphabetically
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
    };
  });

  return { pools: poolsWithUsage, workspace };
}
