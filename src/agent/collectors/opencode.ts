/**
 * OpenCode collector stub — mocked data for dry-run / base agent.
 *
 * Real implementation (EGA-403) will scrape usage from the OpenCode CLI or API.
 */
import type { QuotaPoolSnapshot, ToolInfo } from "../payload";

export interface OpenCodeCollectorResult {
  snapshots: QuotaPoolSnapshot[];
  toolInfos: ToolInfo[];
  rawMetadata?: Record<string, unknown>;
}

export async function collectOpenCode(): Promise<OpenCodeCollectorResult> {
  // Mock data — never collected from real provider
  const now = new Date();

  const snapshots: QuotaPoolSnapshot[] = [
    {
      quotaPoolId: "00000000-0000-0000-0000-000000000002",
      windowName: `${now.toISOString().slice(0, 7)}-monthly`,
      usageAmount: 3400,
      windowStart: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
      windowEnd: new Date(
        now.getFullYear(),
        now.getMonth() + 1,
        0,
        23,
        59,
        59,
      ).toISOString(),
      idempotencyKey: `opencode-mock-${now.toISOString().slice(0, 7)}`,
      source: "heartbeat",
      confidence: 0.85,
    },
  ];

  const toolInfos: ToolInfo[] = [
    {
      toolType: "opencode",
      displayName: "OpenCode CLI",
      agentFingerprint: "opencode-mock-fingerprint-001",
      metadata: JSON.stringify({ version: "mock-0.2.0", mode: "dry-run" }),
    },
  ];

  return {
    snapshots,
    toolInfos,
    rawMetadata: { opencodeConfigPath: "/home/user/.opencode/config.json" },
  };
}
