/**
 * Codex collector — detects local Codex CLI installation, reads safe model
 * metadata from ~/.codex/config.toml, and attempts a safe `codex status`
 * usage parse when the CLI supports it.
 *
 * PRIVACY SAFEGUARDS:
 *   - Reads ONLY ~/.codex/config.toml (model name only)
 *   - NEVER reads ~/.codex/auth.json (contains tokens)
 *   - Runs only `codex status` / `codex status --json`; never sends prompts.
 *   - NEVER uploads prompts, completions, source code, session contents,
 *     shell history, file names, auth tokens, API keys, or cookies.
 *   - All output is passed through sanitize() before returning.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { QuotaPoolSnapshot, ToolInfo } from "../payload";
import { sanitize } from "../sanitizer";

const execFileAsync = promisify(execFile);
const CODEX_CHATGPT_POOL_ID = "00000000-0000-0000-0000-000000000001";

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
    poolId: CODEX_CHATGPT_POOL_ID,
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

type CodexStatusUsage = {
  usageAmount: number;
  source: "codex-status";
  confidence: number;
  resetText?: string;
};

function parseCodexStatusText(stdout: string): CodexStatusUsage | null {
  const percentMatch = stdout.match(/(\d+(?:\.\d+)?)\s*%/);
  if (!percentMatch) return null;

  const usageAmount = Number(percentMatch[1]);
  if (!Number.isFinite(usageAmount)) return null;

  const resetMatch = stdout.match(/reset(?:s|ting)?(?:\s+at|\s+in|:)?\s*([^\n]+)/i);
  return {
    usageAmount,
    source: "codex-status",
    confidence: 0.75,
    resetText: resetMatch?.[1]?.trim(),
  };
}

function parseCodexStatusJson(stdout: string): CodexStatusUsage | null {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const candidates = [
      parsed.usagePercent,
      parsed.usage_percentage,
      parsed.percentUsed,
      parsed.percent_used,
      parsed.creditsUsedPercent,
      parsed.credits_used_percent,
    ];
    const usageAmount = candidates.find((value) => typeof value === "number");
    if (typeof usageAmount !== "number" || !Number.isFinite(usageAmount)) {
      return null;
    }
    return {
      usageAmount,
      source: "codex-status",
      confidence: 0.85,
      resetText:
        typeof parsed.resetAt === "string"
          ? parsed.resetAt
          : typeof parsed.reset_at === "string"
            ? parsed.reset_at
            : undefined,
    };
  } catch {
    return null;
  }
}

async function readCodexStatusUsage(): Promise<CodexStatusUsage | null> {
  const options = {
    timeout: 10_000,
    maxBuffer: 128 * 1024,
    env: { ...process.env, CODEX_UNTRUSTED: "1" },
  };

  try {
    const result = await execFileAsync("codex", ["status", "--json"], options);
    const parsed = parseCodexStatusJson(result.stdout);
    if (parsed) return parsed;
  } catch {
    // Older Codex builds may not support JSON status.
  }

  try {
    const result = await execFileAsync("codex", ["status"], options);
    return parseCodexStatusText(result.stdout);
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
  const statusUsage = await readCodexStatusUsage();

  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const snapshots: QuotaPoolSnapshot[] = [
    {
      quotaPoolId: poolId,
      windowName: `${monthKey}-monthly`,
      usageAmount: statusUsage?.usageAmount ?? 0,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      idempotencyKey: `codex-${poolId}-${monthKey}`,
      source: statusUsage?.source ?? "heartbeat",
      confidence: statusUsage?.confidence ?? confidence,
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
        usageStatus: statusUsage ? "codex_status" : "unknown",
        resetText: statusUsage?.resetText,
      }),
    },
  ];

  const rawMetadata: Record<string, unknown> = {
    model: config.model,
    toolType: "codex",
    usageStatus: statusUsage ? "codex_status" : "unknown",
  };

  const result: CodexCollectorResult = {
    snapshots,
    toolInfos,
    rawMetadata,
  };

  return sanitize(result) as CodexCollectorResult;
}
