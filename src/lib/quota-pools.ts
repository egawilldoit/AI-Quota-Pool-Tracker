import { db } from "./db/client";
import {
  quotaPools,
  usageCurrentState,
  workspaces,
} from "./db/schema";
import { eq, and, desc } from "drizzle-orm";

// ── Types ──────────────────────────────────────────────────────

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
  usageCurrent: {
    usageAmount: string;
    windowName: string;
    windowStart: Date;
    windowEnd: Date;
    lastUpdatedAt: Date;
  } | null;
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

  // Get the latest usage state for each pool
  const poolIds = pools.map((p) => p.id);
  const usageStates = poolIds.length > 0
    ? await db
        .select()
        .from(usageCurrentState)
        .where(
          and(
            eq(usageCurrentState.workspaceId, workspaceId),
            // We need to find latest per pool — get all and dedupe
          ),
        )
        .orderBy(desc(usageCurrentState.lastUpdatedAt))
    : [];

  // Build a map of the latest usage state per quota pool
  const usageMap = new Map<string, typeof usageStates[number]>();
  for (const state of usageStates) {
    if (!usageMap.has(state.quotaPoolId)) {
      usageMap.set(state.quotaPoolId, state);
    }
  }

  const poolsWithUsage: QuotaPoolWithUsage[] = pools.map((pool) => {
    const usage = usageMap.get(pool.id) ?? null;
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
      usageCurrent: usage
        ? {
            usageAmount: usage.usageAmount,
            windowName: usage.windowName,
            windowStart: usage.windowStart,
            windowEnd: usage.windowEnd,
            lastUpdatedAt: usage.lastUpdatedAt,
          }
        : null,
    };
  });

  return { pools: poolsWithUsage, workspace };
}
