import { describe, expect, it } from "vitest";

import { isDemoSeedPoolSet, toDashboardState, computeIsDemoSeed } from "../app/dashboard/data";

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

  it("does not let demo seed rows mask registered real device data", () => {
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

    // Device exists → isDemoSeed should be false
    expect(toDashboardState(workspace, pools, [{ id: "device-1" }])).toMatchObject({
      status: "loaded",
      workspace: { isDemoSeed: false },
    });
  });

  it("hides demo banner when registered device exists even with seed rows", () => {
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

    // Device exists → isDemoSeed = false
    expect(computeIsDemoSeed(true, [{ id: "device-1" }], pools)).toBe(false);
  });

  it("marks replaced current state as real when seed usage changes", () => {
    const pools = [
      {
        accountFingerprint: "openai-codex-chatgpt-credits",
        displayName: "Codex & ChatGPT",
        totalAllocated: "1000",
        usageCurrent: { usageAmount: "651" },
      },
      {
        accountFingerprint: "opencode-go-tokens",
        displayName: "OpenCode Go",
        totalAllocated: "5000000",
        usageCurrent: null,
      },
    ];

    expect(isDemoSeedPoolSet(pools)).toBe(false);
    expect(toDashboardState(workspace, pools, [])).toMatchObject({
      status: "loaded",
      workspace: { isDemoSeed: false },
    });
  });

  it("hides demo banner when seed pool usage changed (real data overwrote seed)", () => {
    const pools = [
      {
        accountFingerprint: "openai-codex-chatgpt-credits",
        displayName: "Codex & ChatGPT",
        totalAllocated: "1000",
        usageCurrent: { usageAmount: "0" },
      },
      {
        accountFingerprint: "opencode-go-tokens",
        displayName: "OpenCode Go",
        totalAllocated: "5000000",
        usageCurrent: { usageAmount: "0" },
      },
    ];

    // Usage is "0" not "650" for Codex, and OpenCode now has usageCurrent
    expect(isDemoSeedPoolSet(pools)).toBe(false);
    expect(computeIsDemoSeed(true, [], pools)).toBe(false);
  });

  it("shows demo banner when API says demo, no devices, and seed data unchanged", () => {
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

    expect(computeIsDemoSeed(true, [], pools)).toBe(true); // no devices, seed unchanged
  });

  it("defaults to API workspace.isDemoSeed when no other signals", () => {
    expect(computeIsDemoSeed(true, [], [])).toBe(true); // API says true
    expect(computeIsDemoSeed(false, [], [])).toBe(false); // API says false
  });
});
