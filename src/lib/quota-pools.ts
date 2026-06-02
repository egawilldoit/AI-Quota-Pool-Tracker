import { db } from "./db/client";
import {
  quotaPools,
  usageCurrentState,
  usageSnapshots,
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
  /** All usage windows (one per window_name). May be empty. */
  usageWindows: UsageWindow[];
  /** Most recently updated window, or null. Backward compat. */
  usageCurrent: UsageWindow | null;
};

export type GetQuotaPoolsResponse = {
  pools: QuotaPoolWithUsage[];
  workspace: { id: string; name: string; slug: string };
};

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
    };
  });

  return { pools: poolsWithUsage, workspace: ws };
}
