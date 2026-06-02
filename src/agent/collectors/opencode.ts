/**
 * OpenCode collector — classifies OpenCode provider via `opencode models`.
 *
 * Detects which provider(s) are configured by parsing model names:
 *   - Models starting with "opencode-go/" → OpenCode Go pool
 *   - Models starting with "openai/"      → OpenAI Provider pool
 *   - Models starting with "opencode/"    → Free/Default (no separate billing)
 *   - Others → ignored for classification
 *
 * OpenCode Go currently uses an API-key style connection flow (`opencode auth`
 * / Zen `/connect`), but this collector does not read those keys and does not
 * assume a stable official usage endpoint. Usage remains unknown/manual unless
 * an official machine-readable usage API is added.
 *
 * Only runs `opencode models` (safe subprocess) — NEVER reads auth.json,
 * config.jsonc, API keys, or any file containing tokens or secrets.
 * All output is sanitized via sanitize().
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { QuotaPoolSnapshot, ToolInfo } from "../payload";
import { sanitize } from "../sanitizer";
import { resolvePoolId } from "../pool-map";

const execFileAsync = promisify(execFile);

export interface OpenCodeCollectorResult {
  snapshots: QuotaPoolSnapshot[];
  toolInfos: ToolInfo[];
  rawMetadata?: Record<string, unknown>;
}

interface OpenCodeModelEntry {
  provider: string; // prefix before "/"
  model: string;    // full model name
}

/**
 * Parse lines of `opencode models` output into structured entries.
 */
function parseModelsOutput(output: string): OpenCodeModelEntry[] {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  const entries: OpenCodeModelEntry[] = [];

  for (const line of lines) {
    const slashIdx = line.indexOf("/");
    if (slashIdx === -1) continue; // malformed, skip
    const provider = line.slice(0, slashIdx);
    entries.push({ provider, model: line });
  }

  return entries;
}

/**
 * Classify the active OpenCode quota pool based on detected model prefixes.
 */
function classifyPool(entries: OpenCodeModelEntry[]): {
  quotaPoolId: string;
  poolName: string;
  confidence: number;
} {
  const hasOpenCodeGo = entries.some((e) => e.provider === "opencode-go");
  const hasOpenAi = entries.some((e) => e.provider === "openai");
  const hasOpenCodeFree = entries.some((e) => e.provider === "opencode");

  if (hasOpenCodeGo) {
    return {
      quotaPoolId: resolvePoolId("tokens"), // OpenCode Go
      poolName: "OpenCode Go",
      confidence: 0.8,
    };
  }

  if (hasOpenAi) {
    return {
      quotaPoolId: resolvePoolId("api_calls"), // OpenAI Provider
      poolName: "OpenAI Provider",
      confidence: 0.7,
    };
  }

  if (hasOpenCodeFree) {
    return {
      quotaPoolId: resolvePoolId("free"), // Free/Unknown
      poolName: "Free",
      confidence: 0.5,
    };
  }

  // No relevant models detected — fallback
  return {
    quotaPoolId: resolvePoolId("free"),
    poolName: "Unknown",
    confidence: 0.3,
  };
}

export async function collectOpenCode(): Promise<OpenCodeCollectorResult> {
  // ── Detect OpenCode installation ─────────────────────────────
  let stdout: string;
  try {
    const result = await execFileAsync("opencode", ["models"], {
      timeout: 15_000, // 15s timeout — don't hang
      maxBuffer: 1024 * 512, // 512KB enough for model list
    });
    stdout = result.stdout;
  } catch {
    // opencode not installed or failed — return empty, no error
    return { snapshots: [], toolInfos: [] };
  }

  // ── Parse ────────────────────────────────────────────────────
  const entries = parseModelsOutput(stdout);
  if (entries.length === 0) {
    return { snapshots: [], toolInfos: [] };
  }

  const pool = classifyPool(entries);

  // ── Build snapshot ───────────────────────────────────────────
  const now = new Date();
  const windowStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const windowEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

  const snapshot: QuotaPoolSnapshot = {
    quotaPoolId: pool.quotaPoolId,
    windowName: `${now.toISOString().slice(0, 7)}-monthly`,
    usageAmount: 0, // opencode models doesn't give usage — 0 as baseline
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    idempotencyKey: `opencode-${pool.poolName.toLowerCase().replace(/\s+/g, "-")}-${now.toISOString().slice(0, 7)}`,
    source: "heartbeat",
    confidence: pool.confidence,
  };

  // ── Build ToolInfo ───────────────────────────────────────────
  const toolInfo: ToolInfo = {
    toolType: "opencode",
    displayName: `OpenCode CLI (${pool.poolName})`,
    agentFingerprint: `opencode-${pool.poolName.toLowerCase().replace(/\s+/g, "-")}-fingerprint`,
    metadata: JSON.stringify({
      version: "detected",
      pool: pool.poolName,
      usageStatus: "unknown_manual_required",
      modelsCount: entries.length,
      detectedProviders: [...new Set(entries.map((e) => e.provider))].sort(),
    }),
  };

  // ── Build raw metadata (no secrets) ──────────────────────────
  const rawMetadata: Record<string, unknown> = {
    opencodeBinary: "/usr/local/bin/opencode",
    modelsCount: entries.length,
    detectedProviders: [...new Set(entries.map((e) => e.provider))].sort(),
    classifiedPool: pool.poolName,
    usageStatus: "unknown_manual_required",
  };

  const result: OpenCodeCollectorResult = {
    snapshots: [snapshot],
    toolInfos: [toolInfo],
    rawMetadata,
  };

  // Sanitize everything before returning
  return sanitize(result) as OpenCodeCollectorResult;
}
