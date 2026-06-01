/**
 * Hermes collector stub — mocked data for dry-run / base agent.
 *
 * Real implementation (EGA-404) will scrape usage from the Hermes agent.
 */
import type { QuotaPoolSnapshot, ToolInfo } from "../payload";

export interface HermesCollectorResult {
  snapshots: QuotaPoolSnapshot[];
  toolInfos: ToolInfo[];
  rawMetadata?: Record<string, unknown>;
}

export async function collectHermes(): Promise<HermesCollectorResult> {
  // Mock data — never collected from real provider
  const now = new Date();

  const snapshots: QuotaPoolSnapshot[] = [
    {
      quotaPoolId: "00000000-0000-0000-0000-000000000003",
      windowName: `${now.toISOString().slice(0, 7)}-monthly`,
      usageAmount: 890,
      windowStart: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
      windowEnd: new Date(
        now.getFullYear(),
        now.getMonth() + 1,
        0,
        23,
        59,
        59,
      ).toISOString(),
      idempotencyKey: `hermes-mock-${now.toISOString().slice(0, 7)}`,
      source: "heartbeat",
      confidence: 0.95,
    },
  ];

  const toolInfos: ToolInfo[] = [
    {
      toolType: "hermes",
      displayName: "Hermes Agent",
      agentFingerprint: "hermes-mock-fingerprint-001",
      metadata: JSON.stringify({ version: "mock-0.3.0", mode: "dry-run" }),
    },
  ];

  return {
    snapshots,
    toolInfos,
    rawMetadata: { hermesConfigPath: "/home/user/.hermes/config.json" },
  };
}
