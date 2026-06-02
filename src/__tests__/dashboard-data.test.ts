import { describe, expect, it } from "vitest";

import { isDemoSeedPoolSet, toDashboardState } from "../app/dashboard/data";

describe("dashboard data states", () => {
  const workspace = { id: "workspace-1", name: "Production", slug: "prod" };

  it("shows explicit empty state without fake pools", () => {
    expect(toDashboardState(workspace, [], [])).toEqual({
      status: "empty",
      workspace,
      devices: [],
    });
  });

  it("marks known seed pool set as demo", () => {
    const pools = [
      {
        accountFingerprint: "openai-codex-chatgpt-credits",
        displayName: "Codex & ChatGPT",
        totalAllocated: "1000",
        usageCurrent: { usageAmount: "650" },
      },
      {
        accountFingerprint: "opencode-go-tokens",
        displayName: "OpenCode Go",
        totalAllocated: "5000000",
        usageCurrent: null,
      },
    ];

    expect(isDemoSeedPoolSet(pools)).toBe(true);
    expect(toDashboardState(workspace, pools, [])).toMatchObject({
      status: "loaded",
      workspace: { isDemoSeed: true },
    });
  });
});
