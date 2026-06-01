/**
 * Codex collector — detects local Codex CLI installation and reads model
 * metadata from ~/.codex/config.toml (model name only) to produce a
 * normalized QuotaPoolSnapshot and ToolInfo entry.
 *
 * PRIVACY SAFEGUARDS:
 *   - Reads ONLY ~/.codex/config.toml (model name, reasoning effort, etc.)
 *   - NEVER reads ~/.codex/auth.json (contains tokens)
 *   - NEVER uploads prompts, completions, source code, session contents,
 *     shell history, file names, auth tokens, API keys, or cookies.
 *   - All output is passed through sanitize() before returning.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { QuotaPoolSnapshot, ToolInfo } from "../payload";
import { sanitize } from "../sanitizer";

export interface CodexCollectorResult {
  snapshots: QuotaPoolSnapshot[];
  toolInfos: ToolInfo[];
  rawMetadata?: Record<string, unknown>;
}

/** Known paid-model prefixes that map to high-confidence usage. */
const PAID_MODEL_PREFIXES = ["gpt-", "o1", "o3", "o4"];

/**
 * Classify a model name string into a confidence level and pool label.
 *
 * - "gpt-*", "o1*", "o3*", "o4*" → high-confidence paid (0.9)
 * - everything else → moderate confidence (0.7)
 */
function classifyModel(model: string): { confidence: number; poolId: string } {
  const normalized = model.trim().toLowerCase();
  const isPaid = PAID_MODEL_PREFIXES.some((prefix) =>
    normalized.startsWith(prefix.toLowerCase()),
  );
  return {
    confidence: isPaid ? 0.9 : 0.7,
    poolId: "Codex-ChatGPT",
  };
}

/**
 * Derive a stable device fingerprint (consistent across collector runs).
 */
function deriveFingerprint(): string {
  const raw = `${os.hostname()}:${os.platform()}:codex`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

/**
 * Extract the model name from a Codex config.toml using a simple regex.
 * We do NOT use a TOML parser to avoid dependency creep and because we
 * only need the one `model = "..."` top-level entry.
 */
function extractModelName(configText: string): string | null {
  // Match lines like: model = "gpt-5.5"   or   model = 'o4-mini'
  // Ignores profiles.* sections by preferring top-level key
  const match = configText.match(/^model\s*=\s*"([^"]+)"/m);
  return match ? match[1] : null;
}

/**
 * Read and parse Codex config safely. Returns null on any failure.
 */
function readCodexConfig(): { model: string; configDir: string } | null {
  const homeDir = os.homedir();
  const configPath = path.join(homeDir, ".codex", "config.toml");

  try {
    if (!fs.existsSync(configPath)) {
      return null;
    }

    const raw = fs.readFileSync(configPath, "utf-8");
    const model = extractModelName(raw);

    if (!model) {
      return null;
    }

    return { model, configDir: path.join(homeDir, ".codex") };
  } catch {
    return null;
  }
}

export async function collectCodex(): Promise<CodexCollectorResult> {
  const now = new Date();
  const windowStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const windowEnd = new Date(
    now.getFullYear(),
    now.getMonth() + 1,
    0,
    23,
    59,
    59,
  );

  const config = readCodexConfig();

  if (!config) {
    // Codex not installed or config not readable — return empty data with
    // a basic ToolInfo so the system knows Codex was checked.
    const result: CodexCollectorResult = {
      snapshots: [],
      toolInfos: [
        {
          toolType: "codex",
          displayName: "Codex CLI",
          agentFingerprint: `codex-${deriveFingerprint()}`,
          metadata: JSON.stringify({ detected: false }),
        },
      ],
      rawMetadata: { error: "Codex config not found or unreadable" },
    };
    return sanitize(result) as CodexCollectorResult;
  }

  const { confidence, poolId } = classifyModel(config.model);

  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const snapshots: QuotaPoolSnapshot[] = [
    {
      quotaPoolId: poolId,
      windowName: `${monthKey}-monthly`,
      usageAmount: 0,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      idempotencyKey: `codex-${poolId}-${monthKey}`,
      source: "heartbeat",
      confidence,
    },
  ];

  const toolInfos: ToolInfo[] = [
    {
      toolType: "codex",
      displayName: "Codex CLI",
      agentFingerprint: `codex-${deriveFingerprint()}`,
      metadata: JSON.stringify({
        detected: true,
        model: config.model,
      }),
    },
  ];

  const rawMetadata: Record<string, unknown> = {
    model: config.model,
    toolType: "codex",
  };

  const result: CodexCollectorResult = {
    snapshots,
    toolInfos,
    rawMetadata,
  };

  return sanitize(result) as CodexCollectorResult;
}
