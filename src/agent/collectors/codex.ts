/**
 * Codex collector stub — mocked data for dry-run / base agent.
 *
 * Real implementation (EGA-402) will scrape usage from Codex CLI or API.
 */
import type { QuotaPoolSnapshot, ToolInfo } from "../payload";

export interface CodexCollectorResult {
  snapshots: QuotaPoolSnapshot[];
  toolInfos: ToolInfo[];
  rawMetadata?: Record<string, unknown>;
}

export async function collectCodex(): Promise<CodexCollectorResult> {
  // Mock data — never collected from real provider
  const now = new Date();

  const snapshots: QuotaPoolSnapshot[] = [
    {
      quotaPoolId: "00000000-0000-0000-0000-000000000001",
      windowName: `${now.toISOString().slice(0, 7)}-monthly`,
      usageAmount: 1250,
      windowStart: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
      windowEnd: new Date(
        now.getFullYear(),
        now.getMonth() + 1,
        0,
        23,
        59,
        59,
      ).toISOString(),
      idempotencyKey: `codex-mock-${now.toISOString().slice(0, 7)}`,
      source: "heartbeat",
      confidence: 0.9,
    },
  ];

  const toolInfos: ToolInfo[] = [
    {
      toolType: "codex",
      displayName: "Codex CLI",
      agentFingerprint: "codex-mock-fingerprint-001",
      metadata: JSON.stringify({ version: "mock-0.1.0", mode: "dry-run" }),
    },
  ];

  return {
    snapshots,
    toolInfos,
    rawMetadata: { codexConfigPath: "/home/user/.codex/config.json" },
  };
}
