/**
 * OpenCode collector — detects OpenCode installation and provider via
 * `opencode models`, and supports manual usage entry via CLI.
 *
 * COLLECTION PATHS:
 *
 * A. Provider detection — `opencode models` (always runs if opencode exists)
 *    Classifies provider prefix to determine quota pool.
 *    Usage remains unknown unless real usage data is available.
 *
 * B. Manual usage entry — CLI subcommand:
 *    node scripts/ega-devtrack.js opencode-go manual \
 *      --rolling-used-pct 3 --weekly-used-pct 5 --monthly-used-pct 14 \
 *      --rolling-reset "57 minutes" --weekly-reset "5 days 11 hours" \
 *      --monthly-reset "26 days 8 hours"
 *    Creates snapshots with source="manual_opencode_go", confidence="manual_confirmed".
 *
 * C. Experimental browser path — gated by env flag:
 *    DEVTRACK_EXPERIMENTAL_OPENCODE_GO_USAGE=1
 *    DEVTRACK_OPENCODE_WORKSPACE_ID=wrk_...
 *    (not implemented — needs explicit opt-in and local browser session)
 *
 * PRIVACY: Only runs `opencode models`. NEVER reads auth.json, config.jsonc,
 * API keys, or any file containing tokens or secrets.
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
  provider: string;
  model: string;
}

// ── Manual Entry Types ────────────────────────────────────────

export interface OpenCodeGoManualInput {
  rollingUsedPct: number;
  weeklyUsedPct: number;
  monthlyUsedPct: number;
  rollingReset?: string;
  weeklyReset?: string;
  monthlyReset?: string;
}

// ── Model Parsing ─────────────────────────────────────────────

function parseModelsOutput(output: string): OpenCodeModelEntry[] {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  const entries: OpenCodeModelEntry[] = [];

  for (const line of lines) {
    const slashIdx = line.indexOf("/");
    if (slashIdx === -1) continue;
    const provider = line.slice(0, slashIdx);
    entries.push({ provider, model: line });
  }

  return entries;
}

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
      quotaPoolId: resolvePoolId("tokens"),
      poolName: "OpenCode Go",
      confidence: 0.8,
    };
  }
  if (hasOpenAi) {
    return {
      quotaPoolId: resolvePoolId("api_calls"),
      poolName: "OpenAI Provider",
      confidence: 0.7,
    };
  }
  if (hasOpenCodeFree) {
    return {
      quotaPoolId: resolvePoolId("free"),
      poolName: "Free",
      confidence: 0.5,
    };
  }

  return {
    quotaPoolId: resolvePoolId("free"),
    poolName: "Unknown",
    confidence: 0.3,
  };
}

// ── Manual Usage Builder ──────────────────────────────────────

/**
 * Build usage snapshots from manually entered OpenCode Go usage values.
 * This is called from the CLI subcommand, not the automatic collector.
 */
export function buildOpenCodeGoManualSnapshots(
  input: OpenCodeGoManualInput,
): QuotaPoolSnapshot[] {
  const now = new Date();
  const poolId = resolvePoolId("tokens");
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const windows: { name: string; usedPct: number; reset?: string }[] = [
    { name: "rolling", usedPct: input.rollingUsedPct, reset: input.rollingReset },
    { name: "weekly", usedPct: input.weeklyUsedPct, reset: input.weeklyReset },
    { name: "monthly", usedPct: input.monthlyUsedPct, reset: input.monthlyReset },
  ];

  return windows.map((w) => {
    // Compute window boundaries based on reset text or defaults
    let windowStart: Date;
    let windowEnd: Date;

    if (w.reset) {
      // Parse reset strings like "57 minutes", "5 days 11 hours", "26 days 8 hours"
      const resetMs = parseResetToMs(w.reset);
      windowEnd = new Date(now.getTime() + resetMs);
      windowStart = now;
    } else {
      // Defaults: rolling=1h, weekly=7d, monthly=30d
      switch (w.name) {
        case "rolling":
          windowEnd = new Date(now.getTime() + 60 * 60 * 1000);
          break;
        case "weekly":
          windowEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
          break;
        case "monthly":
          windowEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
          break;
        default:
          windowEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      }
      windowStart = now;
    }

    return {
      quotaPoolId: poolId,
      windowName: `opencode-go-${w.name}`,
      usageAmount: w.usedPct,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      idempotencyKey: `opencode-go-manual-${w.name}-${monthKey}-${now.getTime()}`,
      source: "manual_opencode_go",
      confidence: 0.95,
    };
  });
}

/**
 * Parse a human-readable reset duration into milliseconds.
 * Examples: "57 minutes", "5 days 11 hours", "26 days 8 hours", "2 hours"
 */
function parseResetToMs(reset: string): number {
  let totalMs = 0;
  const lower = reset.toLowerCase();

  // Match patterns like "5 days", "11 hours", "57 minutes"
  const dayMatch = lower.match(/(\d+)\s*day/);
  if (dayMatch) totalMs += Number(dayMatch[1]) * 24 * 60 * 60 * 1000;

  const hourMatch = lower.match(/(\d+)\s*hour/);
  if (hourMatch) totalMs += Number(hourMatch[1]) * 60 * 60 * 1000;

  const minMatch = lower.match(/(\d+)\s*min/);
  if (minMatch) totalMs += Number(minMatch[1]) * 60 * 1000;

  const secMatch = lower.match(/(\d+)\s*sec/);
  if (secMatch) totalMs += Number(secMatch[1]) * 1000;

  // Default: if nothing matched, return 24 hours
  return totalMs > 0 ? totalMs : 24 * 60 * 60 * 1000;
}

// ── Main Collector ────────────────────────────────────────────

export async function collectOpenCode(): Promise<OpenCodeCollectorResult> {
  // ── Detect OpenCode installation ─────────────────────────
  let stdout: string;
  try {
    const result = await execFileAsync("opencode", ["models"], {
      timeout: 15_000,
      maxBuffer: 1024 * 512,
    });
    stdout = result.stdout;
  } catch {
    return { snapshots: [], toolInfos: [] };
  }

  // ── Parse ────────────────────────────────────────────────
  const entries = parseModelsOutput(stdout);
  if (entries.length === 0) {
    return { snapshots: [], toolInfos: [] };
  }

  const pool = classifyPool(entries);
  const now = new Date();

  // ── Build detection snapshots with usage_unknown (-1) ─────
  // Each pool gets a detection snapshot — usage unknown until manual entry.
  // Only emit for OpenCode Go (the pool we care about).
  const snapshots: QuotaPoolSnapshot[] = [];

  if (pool.poolName === "OpenCode Go") {
    const USAGE_UNKNOWN = -1;
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const windows = ["rolling", "weekly", "monthly"];

    for (const windowName of windows) {
      let windowStart: Date;
      let windowEnd: Date;

      switch (windowName) {
        case "rolling":
          windowEnd = new Date(now.getTime() + 60 * 60 * 1000);
          windowStart = now;
          break;
        case "weekly": {
          const start = new Date(now);
          const day = start.getDay();
          const diff = start.getDate() - day + (day === 0 ? -6 : 1);
          start.setDate(diff);
          start.setHours(0, 0, 0, 0);
          windowStart = start;
          windowEnd = new Date(start);
          windowEnd.setDate(windowEnd.getDate() + 7);
          break;
        }
        case "monthly":
        default:
          windowStart = new Date(now.getFullYear(), now.getMonth(), 1);
          windowEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
      }

      snapshots.push({
        quotaPoolId: pool.quotaPoolId,
        windowName: `opencode-go-${windowName}`,
        usageAmount: USAGE_UNKNOWN,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        idempotencyKey: `opencode-go-detect-${windowName}-${monthKey}`,
        source: "detected",
        confidence: pool.confidence,
      });
    }
  } else {
    // Non-OpenCode-Go pools: just emit a heartbeat-style single snapshot
    const windowStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const windowEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    snapshots.push({
      quotaPoolId: pool.quotaPoolId,
      windowName: `${monthKey}-monthly`,
      usageAmount: -1, // unknown
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      idempotencyKey: `opencode-${pool.poolName.toLowerCase().replace(/\s+/g, "-")}-${monthKey}`,
      source: "detected",
      confidence: pool.confidence,
    });
  }

  // ── Build ToolInfo ───────────────────────────────────────
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

  const rawMetadata: Record<string, unknown> = {
    opencodeBinary: "/usr/local/bin/opencode",
    modelsCount: entries.length,
    detectedProviders: [...new Set(entries.map((e) => e.provider))].sort(),
    classifiedPool: pool.poolName,
    usageStatus: "unknown_manual_required",
  };

  const result: OpenCodeCollectorResult = {
    snapshots,
    toolInfos: [toolInfo],
    rawMetadata,
  };

  return sanitize(result) as OpenCodeCollectorResult;
}
