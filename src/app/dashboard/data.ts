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
};

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
      pool.usageCurrent === null,
  );

  return codexSeed && opencodeSeed;
}

export function toDashboardState<TPool extends SeedPoolShape, TDevice>(
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
      isDemoSeed: workspace.isDemoSeed ?? isDemoSeedPoolSet(pools),
    },
    pools,
    devices,
  };
}
