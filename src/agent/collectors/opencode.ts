/**
 * OpenCode collector — detects OpenCode installation and provider via
 * `opencode models`, supports manual usage entry, and opt-in browser
 * dashboard collection.
 *
 * COLLECTION LEVELS:
 *
 * 1. Safe detection (always runs)
 *    Runs `opencode models` to detect provider/model.
 *    Emits detection windows with usageAmount=-1 (unknown).
 *    source="detected", confidence=0.3–0.8
 *
 * 2. Manual usage entry (CLI subcommand)
 *    `ega-devtrack opencode-go manual --rolling-used-pct N ...`
 *    source="manual_opencode_go", confidence=0.95
 *
 * 3. Experimental browser dashboard collector — opt-in only
 *    Flag: DEVTRACK_EXPERIMENTAL_OPENCODE_GO_BROWSER_USAGE=1
 *    Workspace ID: DEVTRACK_OPENCODE_GO_WORKSPACE_ID=wrk_...
 *    Targets: https://opencode.ai/workspace/<workspaceId>/go
 *    Uses Playwright to read visible usage text from the page.
 *    Extracts: Rolling Usage %, Weekly Usage %, Monthly Usage %
 *    source="opencode_go_browser_dashboard", confidence=0.95
 *
 * 4. Local config path (optional)
 *    ~/.local/share/ega-devtrack/opencode-go.json
 *    Contains workspaceId and browser collector preference.
 *    Git-ignored, never committed.
 *
 * PRIVACY:
 * - Only runs `opencode models` (safe subprocess) — NEVER reads auth.json,
 *   config.jsonc, API keys, or any file containing tokens or secrets.
 * - Browser collector is disabled by default.
 * - NEVER uploads cookies, auth tokens, browser state, or raw HTML.
 * - All output is sanitized via sanitize().
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

// ── Local Config ──────────────────────────────────────────────

interface OpenCodeGoLocalConfig {
  workspaceId?: string;
  browserCollectorEnabled?: boolean;
}

function localConfigPath(): string {
  return path.join(
    os.homedir(),
    ".local", "share", "ega-devtrack",
    "opencode-go.json",
  );
}

function readLocalConfig(): OpenCodeGoLocalConfig {
  try {
    const fp = localConfigPath();
    if (!fs.existsSync(fp)) return {};
    return JSON.parse(fs.readFileSync(fp, "utf-8")) as OpenCodeGoLocalConfig;
  } catch {
    return {};
  }
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
 * Exported for CLI use.
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
    let windowStart: Date;
    let windowEnd: Date;

    if (w.reset) {
      const resetMs = parseResetToMs(w.reset);
      windowEnd = new Date(now.getTime() + resetMs);
      windowStart = now;
    } else {
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
 * Examples: "57 minutes", "5 days 11 hours", "26 days 8 hours"
 */
export function parseResetToMs(reset: string): number {
  let totalMs = 0;
  const lower = reset.toLowerCase();

  const dayMatch = lower.match(/(\d+)\s*day/);
  if (dayMatch) totalMs += Number(dayMatch[1]) * 24 * 60 * 60 * 1000;

  const hourMatch = lower.match(/(\d+)\s*hour/);
  if (hourMatch) totalMs += Number(hourMatch[1]) * 60 * 60 * 1000;

  const minMatch = lower.match(/(\d+)\s*min/);
  if (minMatch) totalMs += Number(minMatch[1]) * 60 * 1000;

  const secMatch = lower.match(/(\d+)\s*sec/);
  if (secMatch) totalMs += Number(secMatch[1]) * 1000;

  return totalMs > 0 ? totalMs : 24 * 60 * 60 * 1000;
}

// ── Level 3: Browser Dashboard Collector ─────────────────────

interface OpenCodeGoBrowserUsage {
  rollingUsedPct: number;
  weeklyUsedPct: number;
  monthlyUsedPct: number;
  rollingReset?: string;
  weeklyReset?: string;
  monthlyReset?: string;
}

function isExperimentalBrowserEnabled(): boolean {
  return process.env.DEVTRACK_EXPERIMENTAL_OPENCODE_GO_BROWSER_USAGE === "1";
}

function getWorkspaceId(): string | null {
  return process.env.DEVTRACK_OPENCODE_GO_WORKSPACE_ID
    ?? readLocalConfig().workspaceId
    ?? null;
}

function hasPlaywright(): boolean {
  try {
    require.resolve("playwright");
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse OpenCode Go workspace dashboard text.
 * Expected format (from opencode.ai workspace page):
 * ```
 * Rolling Usage 3%
 * Weekly Usage 5%
 * Monthly Usage 14%
 * ```
 * Also parses reset hints like "Resets in 57 minutes"
 * Exported for testing.
 */
export function parseOpenCodeGoDashboardText(htmlText: string): OpenCodeGoBrowserUsage | null {
  // Strip HTML and normalize
  const plainText = htmlText
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

  const rollingMatch = plainText.match(/rolling\s*usage\s*(\d+(?:\.\d+)?)\s*%/i);
  const weeklyMatch = plainText.match(/weekly\s*usage\s*(\d+(?:\.\d+)?)\s*%/i);
  const monthlyMatch = plainText.match(/monthly\s*usage\s*(\d+(?:\.\d+)?)\s*%/i);

  if (!rollingMatch && !weeklyMatch && !monthlyMatch) return null;

  const result: OpenCodeGoBrowserUsage = {
    rollingUsedPct: rollingMatch ? Number(rollingMatch[1]) : -1,
    weeklyUsedPct: weeklyMatch ? Number(weeklyMatch[1]) : -1,
    monthlyUsedPct: monthlyMatch ? Number(monthlyMatch[1]) : -1,
  };

  // Try to extract reset hints
  const rollingReset = plainText.match(/rolling\s*.*?reset(?:s)?\s*(?:in|:)\s*([^,.]+)/i);
  const weeklyReset = plainText.match(/weekly\s*.*?reset(?:s)?\s*(?:in|:)\s*([^,.]+)/i);
  const monthlyReset = plainText.match(/monthly\s*.*?reset(?:s)?\s*(?:in|:)\s*([^,.]+)/i);

  if (rollingReset) result.rollingReset = rollingReset[1].trim();
  if (weeklyReset) result.weeklyReset = weeklyReset[1].trim();
  if (monthlyReset) result.monthlyReset = monthlyReset[1].trim();

  return result;
}

/**
 * Collect OpenCode Go usage via browser dashboard.
 *
 * SKELETON — full Playwright implementation not yet integrated.
 * When enabled, this will:
 * 1. Launch headless Chromium via Playwright
 * 2. Navigate to opencode.ai workspace page
 * 3. Extract visible usage percentages and reset times
 * 4. Return ONLY normalized metadata
 */
async function collectBrowserUsage(): Promise<QuotaPoolSnapshot[] | null> {
  if (!isExperimentalBrowserEnabled()) return null;

  if (!hasPlaywright()) {
    console.warn(
      "[opencode:browser] Experimental browser collector is enabled but Playwright is not installed.\n" +
      "  Install with: npm install playwright\n" +
      "  Then: npx playwright install chromium\n" +
      "  Skipping browser collection.",
    );
    return null;
  }

  const workspaceId = getWorkspaceId();
  if (!workspaceId) {
    console.warn(
      "[opencode:browser] Experimental browser collector enabled but no workspace ID.\n" +
      "  Set DEVTRACK_OPENCODE_GO_WORKSPACE_ID=wrk_... or add to ~/.local/share/ega-devtrack/opencode-go.json\n" +
      "  Skipping browser collection.",
    );
    return null;
  }

  console.warn(
    "[opencode:browser] Experimental browser dashboard collector is ENABLED.\n" +
    `  Workspace: https://opencode.ai/workspace/${workspaceId}/go\n` +
    "  This will read usage from the OpenCode Go workspace page using a local browser.\n" +
    "  Only normalized usage percentages and reset times are uploaded.\n" +
    "  Cookies, auth tokens, and raw HTML are NEVER uploaded.\n" +
    "  To disable: unset DEVTRACK_EXPERIMENTAL_OPENCODE_GO_BROWSER_USAGE",
  );

  // --- Browser collection stub ---
  // Full implementation requires Playwright integration
  console.warn(
    "[opencode:browser] Browser collection not yet fully implemented.\n" +
    "  Use `ega-devtrack opencode-go manual ...` to enter usage values, or\n" +
    "  enter usage via the dashboard manual usage form.",
  );
  return null;
}

// ── Main Collector ────────────────────────────────────────────

export async function collectOpenCode(): Promise<OpenCodeCollectorResult> {
  const USAGE_UNKNOWN = -1;
  const now = new Date();

  // ── Detect OpenCode ─────────────────────────────────────────
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

  const entries = parseModelsOutput(stdout);
  if (entries.length === 0) {
    return { snapshots: [], toolInfos: [] };
  }

  const pool = classifyPool(entries);

  // ── Try browser collection (Level 3) ────────────────────────
  const browserSnapshots = await collectBrowserUsage();

  let snapshots: QuotaPoolSnapshot[];
  let usageSource: string;
  let usageStatus: string;

  if (browserSnapshots && browserSnapshots.length > 0) {
    snapshots = browserSnapshots;
    usageSource = "opencode_go_browser_dashboard";
    usageStatus = "browser_confirmed";
  } else if (pool.poolName === "OpenCode Go") {
    // Emit detection windows
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    usageSource = "detected";
    usageStatus = "unknown_manual_required";

    snapshots = [
      {
        quotaPoolId: pool.quotaPoolId,
        windowName: "opencode-go-rolling",
        usageAmount: USAGE_UNKNOWN,
        windowStart: now.toISOString(),
        windowEnd: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
        idempotencyKey: `opencode-go-detect-rolling-${monthKey}`,
        source: usageSource,
        confidence: pool.confidence,
      },
      {
        quotaPoolId: pool.quotaPoolId,
        windowName: "opencode-go-weekly",
        usageAmount: USAGE_UNKNOWN,
        windowStart: (() => {
          const s = new Date(now);
          const d = s.getDay();
          s.setDate(s.getDate() - d + (d === 0 ? -6 : 1));
          s.setHours(0, 0, 0, 0);
          return s.toISOString();
        })(),
        windowEnd: (() => {
          const s = new Date(now);
          const d = s.getDay();
          s.setDate(s.getDate() - d + (d === 0 ? -6 : 1) + 7);
          s.setHours(0, 0, 0, 0);
          return s.toISOString();
        })(),
        idempotencyKey: `opencode-go-detect-weekly-${monthKey}`,
        source: usageSource,
        confidence: pool.confidence,
      },
      {
        quotaPoolId: pool.quotaPoolId,
        windowName: "opencode-go-monthly",
        usageAmount: USAGE_UNKNOWN,
        windowStart: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
        windowEnd: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).toISOString(),
        idempotencyKey: `opencode-go-detect-monthly-${monthKey}`,
        source: usageSource,
        confidence: pool.confidence,
      },
    ];
  } else {
    // Non-OpenCode-Go pools: simple heartbeat
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    usageSource = "detected";
    usageStatus = "detected";

    snapshots = [
      {
        quotaPoolId: pool.quotaPoolId,
        windowName: `${monthKey}-monthly`,
        usageAmount: USAGE_UNKNOWN,
        windowStart: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
        windowEnd: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).toISOString(),
        idempotencyKey: `opencode-${pool.poolName.toLowerCase().replace(/\s+/g, "-")}-${monthKey}`,
        source: usageSource,
        confidence: pool.confidence,
      },
    ];
  }

  // ── Build ToolInfo ──────────────────────────────────────────
  const toolInfo: ToolInfo = {
    toolType: "opencode",
    displayName: `OpenCode CLI (${pool.poolName})`,
    agentFingerprint: `opencode-${pool.poolName.toLowerCase().replace(/\s+/g, "-")}-fingerprint`,
    metadata: JSON.stringify({
      version: "detected",
      pool: pool.poolName,
      usageSource,
      usageStatus,
      modelsCount: entries.length,
      detectedProviders: [...new Set(entries.map((e) => e.provider))].sort(),
      browserEnabled: isExperimentalBrowserEnabled(),
    }),
  };

  const rawMetadata: Record<string, unknown> = {
    opencodeBinary: "/usr/local/bin/opencode",
    modelsCount: entries.length,
    detectedProviders: [...new Set(entries.map((e) => e.provider))].sort(),
    classifiedPool: pool.poolName,
    usageSource,
    usageStatus,
    browserEnabled: isExperimentalBrowserEnabled(),
  };

  const result: OpenCodeCollectorResult = { snapshots, toolInfos: [toolInfo], rawMetadata };
  return sanitize(result) as OpenCodeCollectorResult;
}
