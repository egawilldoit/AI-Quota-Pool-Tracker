/**
 * Collector orchestrator — runs all provider collectors and merges results.
 *
 * In dry-run mode, all collectors run and failures are caught silently.
 * The orchestrator always exits 0 (no upload in dry-run) and merges
 * whatever data was collected, sanitizing everything before returning.
 */
import type { IngestPayload, QuotaPoolSnapshot, ToolInfo, ToolQuotaAttribution } from "../payload";
import { sanitize } from "../sanitizer";
import { collectCodex } from "./codex";
import { collectOpenCode } from "./opencode";
import { collectHermes } from "./hermes";

export interface CollectorRunResult {
  payload: IngestPayload;
  errors: string[];
  collectorsRun: number;
  collectorsFailed: number;
}

/**
 * Run all available collectors and merge their data into a single
 * normalized ingest payload. Catches all errors so a single collector
 * failure never crashes the agent.
 */
export async function runAllCollectors(): Promise<CollectorRunResult> {
  const errors: string[] = [];
  const allSnapshots: QuotaPoolSnapshot[] = [];
  const allToolInfos: ToolInfo[] = [];
  const allAttributions: ToolQuotaAttribution[] = [];

  let collectorsRun = 0;
  let collectorsFailed = 0;

  // ── Codex ───────────────────────────────────────────────
  try {
    const result = await collectCodex();
    collectorsRun++;
    allSnapshots.push(...result.snapshots);
    allToolInfos.push(...result.toolInfos);
  } catch (err) {
    collectorsFailed++;
    errors.push(`codex collector failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── OpenCode ────────────────────────────────────────────
  try {
    const result = await collectOpenCode();
    collectorsRun++;
    allSnapshots.push(...result.snapshots);
    allToolInfos.push(...result.toolInfos);
  } catch (err) {
    collectorsFailed++;
    errors.push(`opencode collector failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Hermes ──────────────────────────────────────────────
  try {
    const result = await collectHermes();
    collectorsRun++;
    allSnapshots.push(...result.snapshots);
    allToolInfos.push(...result.toolInfos);
  } catch (err) {
    collectorsFailed++;
    errors.push(`hermes collector failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Build normalized payload
  const rawPayload: IngestPayload = {
    device: {
      deviceFingerprint: "dry-run-device-001",
      agentVersion: "0.1.0",
      os: process.platform,
    },
    quotaPoolSnapshots: allSnapshots,
    toolQuotaAttributions: allAttributions,
    toolInfos: allToolInfos,
  };

  // Sanitize everything — even mock data might contain path-like secrets
  const payload = sanitize(rawPayload) as IngestPayload;

  return {
    payload,
    errors,
    collectorsRun,
    collectorsFailed,
  };
}
