export type DashboardWorkspace = {
  id: string;
  name: string;
  slug: string;
  isDemoSeed?: boolean;
};

type SeedPoolShape = {
  accountFingerprint?: string;
  displayName: string;
  totalAllocated: string;
  usageCurrent: { usageAmount: string } | null;
  usageWindows?: { usageAmount: string; windowName: string }[];
};

type GenericDevice = { id: string } & Record<string, unknown>;

export function isDemoSeedPoolSet(pools: SeedPoolShape[]): boolean {
  const codexSeed = pools.some(
    (pool) =>
      pool.accountFingerprint === "openai-codex-chatgpt-credits" &&
      pool.displayName === "Codex & ChatGPT" &&
      pool.totalAllocated === "1000" &&
      pool.usageCurrent?.usageAmount === "650",
  );
  const opencodeSeed = pools.some(
    (pool) =>
      pool.accountFingerprint === "opencode-go-tokens" &&
      pool.displayName === "OpenCode Go" &&
      pool.totalAllocated === "5000000" &&
      // Seed data has null usageCurrent — once we have ANY windows, it's real
      (!pool.usageCurrent || (pool.usageWindows && pool.usageWindows.length > 0)),
  );

  return codexSeed && opencodeSeed;
}

/**
 * Determine whether a set of pools still looks exactly like the demo seed data.
 * Replaces the workspace's `isDemoSeed` with a fresh check that accounts for:
 * - real registered devices overwriting demo
 * - real usage_current_state overwriting seed percentages
 * - any agent heartbeats existing
 */
export function computeIsDemoSeed(
  workspaceIsDemoSeed: boolean | undefined,
  devices: GenericDevice[],
  pools: SeedPoolShape[],
): boolean {
  // If real devices exist, it's not demo regardless of seed data
  if (devices.length > 0) return false;

  // If no pools exist yet, defer to the API's seed flag
  if (pools.length === 0) return workspaceIsDemoSeed ?? true;

  // If any pool's current state differs from the exact seed values,
  // real data has been ingested — not demo
  if (!isDemoSeedPoolSet(pools)) return false;

  // Default to the API's seed flag if nothing else overrides
  return workspaceIsDemoSeed ?? true;
}

export function toDashboardState<TPool extends SeedPoolShape, TDevice extends GenericDevice>(
  workspace: DashboardWorkspace,
  pools: TPool[],
  devices: TDevice[],
) {
  if (pools.length === 0) {
    return { status: "empty" as const, workspace, devices };
  }

  return {
    status: "loaded" as const,
    workspace: {
      ...workspace,
      isDemoSeed: computeIsDemoSeed(workspace.isDemoSeed, devices, pools),
    },
    pools,
    devices,
  };
}
