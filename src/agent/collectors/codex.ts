/**
 * Codex collector — detects local Codex CLI installation, reads safe model
 * metadata from ~/.codex/config.toml, and collects usage windows at multiple
 * collection levels.
 *
 * COLLECTION LEVELS (in priority order):
 *
 * 1. Safe detection / heartbeat — always runs
 *    Reads ~/.codex/config.toml for model name only.
 *    Emits detection windows with usageAmount=-1 (unknown).
 *    source="detected", confidence=0.7–0.9
 *
 * 2. CLI interactive / PTY parser — runs when TTY is available
 *    Parses `codex status` output for multi-window usage:
 *      - 5 hour usage limit: 54% remaining → 46% used
 *      - weekly usage limit: 76% remaining → 24% used
 *      - credits remaining: 0 of 1000
 *    Converts remaining-to-used.
 *    source="codex_cli_status", confidence=0.85
 *
 * 3. Experimental browser dashboard collector — opt-in only
 *    Flag: DEVTRACK_EXPERIMENTAL_CODEX_BROWSER_USAGE=1
 *    Targets: https://chatgpt.com/codex/cloud/settings/analytics
 *    Uses Playwright to read visible dashboard text only.
 *    Extracts normalized usage percentages and reset times.
 *    NEVER uploads cookies, auth tokens, full HTML, or any dashboard state.
 *    source="codex_browser_dashboard", confidence=0.95
 *
 * PRIVACY SAFEGUARDS:
 *   - Reads ONLY ~/.codex/config.toml (model name only)
 *   - NEVER reads ~/.codex/auth.json (contains tokens)
 *   - Runs only `codex status`; never sends prompts.
 *   - Browser collector is disabled by default and requires explicit env flags.
 *   - NEVER uploads cookies, auth tokens, browser state, or raw HTML.
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
import { resolvePoolId } from "../pool-map";

const execFileAsync = promisify(execFile);

export interface CodexCollectorResult {
  snapshots: QuotaPoolSnapshot[];
  toolInfos: ToolInfo[];
  rawMetadata?: Record<string, unknown>;
}

/** Known paid-model prefixes that map to high-confidence usage. */
const PAID_MODEL_PREFIXES = ["gpt-", "o1", "o3", "o4"];

/** Sentinel: usage is unknown (not 0%!). Dashboard checks for < 0. */
const USAGE_UNKNOWN = -1;

// ── Types ─────────────────────────────────────────────────────

interface CodexUsageWindow {
  windowName: string;   // "5h", "weekly", "credits"
  usedPct: number;       // 0-100 (percent used)
  remainingPct?: number; // original remaining percentage
  resetText?: string;    // e.g. "2026-06-03 02:51"
}

interface CodexUsageResult {
  windows: CodexUsageWindow[];
  source: string;
  confidence: number;
}

export interface CodexManualInput {
  fiveHourRemainingPct: number;
  weeklyRemainingPct: number;
  creditsRemaining: number;
  fiveHourReset?: string;
  weeklyReset?: string;
}

// ── Helpers ───────────────────────────────────────────────────

function classifyModel(model: string): { confidence: number; poolId: string } {
  const normalized = model.trim().toLowerCase();
  const isPaid = PAID_MODEL_PREFIXES.some((prefix) =>
    normalized.startsWith(prefix.toLowerCase()),
  );
  return {
    confidence: isPaid ? 0.9 : 0.7,
    poolId: resolvePoolId("credits"),
  };
}

function deriveFingerprint(): string {
  const raw = `${os.hostname()}:${os.platform()}:codex`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

// ── Config Reading ────────────────────────────────────────────

function extractModelName(configText: string): string | null {
  const match = configText.match(/^model\s*=\s*"([^"]+)"/m);
  return match ? match[1] : null;
}

function readCodexConfig(): { model: string; configDir: string } | null {
  const homeDir = os.homedir();
  const configPath = path.join(homeDir, ".codex", "config.toml");

  try {
    if (!fs.existsSync(configPath)) return null;
    const raw = fs.readFileSync(configPath, "utf-8");
    const model = extractModelName(raw);
    if (!model) return null;
    return { model, configDir: path.join(homeDir, ".codex") };
  } catch {
    return null;
  }
}

// ── Level 2: CLI / PTY Status Parser ─────────────────────────

/**
 * Parse `codex status` multi-window text output.
 *
 * Real output format (Codex latest, visible in TUI status bar):
 * ```
 * 5 hour usage limit
 * 54% remaining    2026-06-03 02:51
 *
 * weekly usage limit
 * 76% remaining    2026-06-08 00:00
 *
 * credits remaining
 * 0 of 1000
 * ```
 *
 * Also handles older formats and locale variations.
 * Exported for testing.
 */
export function parseCodexStatusMultiWindow(stdout: string): CodexUsageWindow[] {
  const windows: CodexUsageWindow[] = [];

  // Split into sections separated by blank lines
  const sections = stdout.split(/\n{2,}/);

  for (const section of sections) {
    const lines = section.split("\n").map((l) => l.trim());
    if (lines.length === 0) continue;

    const headerLine = lines[0].toLowerCase();

    // Determine window type from header
    let windowName: string | null = null;
    if (/5[_\-\s]?hour/i.test(headerLine) || /5h/i.test(headerLine)) {
      windowName = "5h";
    } else if (/weekly/i.test(headerLine) || /week/i.test(headerLine)) {
      windowName = "weekly";
    } else if (/credit/i.test(headerLine)) {
      windowName = "credits";
    } else if (/monthly/i.test(headerLine) || /month/i.test(headerLine)) {
      windowName = "monthly";
    }

    if (!windowName) continue;

    // Find the line with a percentage or credit count
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];

      // Try "XX% remaining" pattern — convert to used
      const pctMatch = line.match(/(\d+(?:\.\d+)?)\s*%\s*(remaining|left|used)/i);
      if (pctMatch) {
        const value = Number(pctMatch[1]);
        const isRemaining = /remaining|left/i.test(pctMatch[2]);
        if (Number.isFinite(value)) {
          const usedPct = isRemaining ? Math.max(0, 100 - value) : value;
          windows.push({
            windowName,
            usedPct,
            remainingPct: isRemaining ? value : undefined,
          });
          break;
        }
      }

      // Try "0 of 1000" credits pattern
      if (windowName === "credits") {
        const creditMatch = line.match(/(\d+(?:\.\d+)?)\s*of\s*(\d+(?:\.\d+)?)/i);
        if (creditMatch) {
          const used = Number(creditMatch[1]);
          const total = Number(creditMatch[2]);
          if (Number.isFinite(used) && Number.isFinite(total) && total > 0) {
            const usedPct = Math.min(100, Math.round((used / total) * 100));
            windows.push({ windowName, usedPct });
            break;
          }
        }
        // Try standalone remaining count
        const numMatch = line.match(/^(\d+(?:\.\d+)?)/);
        if (numMatch && !pctMatch) {
          const remaining = Number(numMatch[1]);
          if (Number.isFinite(remaining)) {
            windows.push({ windowName, usedPct: remaining });
            break;
          }
        }
      }
    }

    // Try to extract reset timestamp
    const resetMatch = section.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/);
    if (resetMatch && windows.length > 0) {
      windows[windows.length - 1].resetText = resetMatch[1];
    }
  }

  return windows;
}

/**
 * Attempt to collect usage via `codex status` text output.
 * Tries PTY wrappers first, then direct exec as fallback.
 */
async function readCodexStatusUsage(): Promise<CodexUsageResult | null> {
  const options = {
    timeout: 20_000,
    maxBuffer: 128 * 1024,
    env: { ...process.env, TERM: "xterm-256color" },
  };

  // Try `script` wrapper (provides PTY on Linux)
  try {
    const result = await execFileAsync("script", [
      "-q", "-c", "codex status 2>/dev/null", "/dev/null",
    ], options);
    const windows = parseCodexStatusMultiWindow(result.stdout);
    if (windows.length > 0) {
      return {
        windows,
        source: "codex_cli_status",
        confidence: 0.85,
      };
    }
  } catch {
    // script approach failed — try direct exec
  }

  // Try direct exec (may fail with "stdin is not a terminal" in cron)
  try {
    const result = await execFileAsync("codex", ["status"], options);
    const windows = parseCodexStatusMultiWindow(result.stdout);
    if (windows.length > 0) {
      return {
        windows,
        source: "codex_cli_status",
        confidence: 0.85,
      };
    }
  } catch {
    // Can't get status non-interactively
  }

  return null;
}

// ── Level 3: Experimental Browser Dashboard Collector ────────

function isExperimentalBrowserEnabled(): boolean {
  return process.env.DEVTRACK_EXPERIMENTAL_CODEX_BROWSER_USAGE === "1";
}

/**
 * Check if Playwright is available as a local dependency.
 */
function hasPlaywright(): boolean {
  try {
    require.resolve("playwright");
    return true;
  } catch {
    return false;
  }
}

/**
 * NOTE: This function is a SKELETON. The actual browser dashboard scraping
 * is not yet implemented here — it requires Playwright as a local dependency
 * and user-configured browser auth. When enabled, it will:
 *
 * 1. Launch a headless browser (Playwright/Chromium)
 * 2. Navigate to https://chatgpt.com/codex/cloud/settings/analytics
 * 3. Extract visible usage text from the page DOM
 * 4. Parse: 5h remaining%, weekly remaining%, credits remaining
 * 5. Return ONLY normalized metadata (no cookies, no HTML, no auth)
 *
 * This collector is OFF by default (requires DEVTRACK_EXPERIMENTAL_CODEX_BROWSER_USAGE=1).
 * It is NOT called from the scheduler or from `once --upload`.
 * It IS called from `usage collect` when the flag is set.
 *
 * If Playwright is not installed or auth is not configured, it fails gracefully
 * with a clear message about what's needed.
 */
async function collectBrowserUsage(): Promise<CodexUsageResult | null> {
  if (!isExperimentalBrowserEnabled()) {
    return null;
  }

  if (!hasPlaywright()) {
    console.warn(
      "[codex:browser] Experimental browser collector is enabled but Playwright is not installed.\n" +
      "  Install with: npm install playwright\n" +
      "  Then: npx playwright install chromium\n" +
      "  Skipping browser collection.",
    );
    return null;
  }

  console.warn(
    "[codex:browser] Experimental browser dashboard collector is ENABLED.\n" +
    "  This will read usage from the Codex Analytics dashboard using a local browser.\n" +
    "  Only normalized usage percentages and reset times are uploaded.\n" +
    "  Cookies, auth tokens, and raw HTML are NEVER uploaded.\n" +
    "  To disable: unset DEVTRACK_EXPERIMENTAL_CODEX_BROWSER_USAGE",
  );

  // --- Browser collection stub ---
  // Full implementation requires:
  // 1. Playwright: const { chromium } = await import("playwright");
  // 2. Launch browser, navigate to dashboard, parse DOM
  // 3. Extract usage text, parse with parseCodexDashboardText()
  // 4. Return CodexUsageResult

  console.warn(
    "[codex:browser] Browser collection not yet fully implemented.\n" +
    "  Use `codex status` from a TTY, or enter usage manually via the dashboard.",
  );
  return null;
}

/**
 * Parse Codex Analytics dashboard page text (same format as status output).
 * Used by the browser collector to extract windows from page content.
 * Exported for testing.
 */
export function parseCodexDashboardText(htmlText: string): CodexUsageWindow[] {
  // The dashboard text should contain the same "X% remaining" patterns
  // Strip HTML tags and normalize whitespace (but preserve line breaks)
  const plainText = htmlText
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .trim();

  return parseCodexStatusMultiWindow(plainText);
}

// ── Window Date Helpers ────────────────────────────────────────

function hourlyWindow(now: Date): { start: Date; end: Date } {
  const start = new Date(now);
  start.setMinutes(0, 0, 0);
  const end = new Date(start);
  end.setHours(end.getHours() + 5);
  return { start, end };
}

function weeklyWindow(now: Date): { start: Date; end: Date } {
  const start = new Date(now);
  const day = start.getDay();
  const diff = start.getDate() - day + (day === 0 ? -6 : 1);
  start.setDate(diff);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return { start, end };
}

function monthlyWindow(now: Date): { start: Date; end: Date } {
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
  return { start, end };
}

// ── Snapshot Builder ──────────────────────────────────────────

function buildSnapshots(
  windows: CodexUsageWindow[],
  poolId: string,
  source: string,
  confidence: number,
  now: Date,
): QuotaPoolSnapshot[] {
  return windows.map((w) => {
    let windowStart: Date;
    let windowEnd: Date;

    switch (w.windowName) {
      case "5h":
        windowStart = hourlyWindow(now).start;
        windowEnd = hourlyWindow(now).end;
        break;
      case "weekly":
        windowStart = weeklyWindow(now).start;
        windowEnd = weeklyWindow(now).end;
        break;
      case "monthly":
      case "credits":
        windowStart = monthlyWindow(now).start;
        windowEnd = monthlyWindow(now).end;
        break;
      default:
        windowStart = monthlyWindow(now).start;
        windowEnd = monthlyWindow(now).end;
    }

    const dateKey = now.toISOString().slice(0, 13);

    return {
      quotaPoolId: poolId,
      windowName: `codex-${w.windowName}`,
      usageAmount: w.usedPct,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      idempotencyKey: `codex-${poolId}-${w.windowName}-${source}-${dateKey}`,
      source,
      confidence,
    };
  });
}

export function buildCodexManualSnapshots(input: CodexManualInput): QuotaPoolSnapshot[] {
  const now = new Date();
  const poolId = resolvePoolId("credits");
  const snapshots = buildSnapshots(
    [
      {
        windowName: "5h",
        usedPct: Math.max(0, Math.min(100, 100 - input.fiveHourRemainingPct)),
        remainingPct: input.fiveHourRemainingPct,
        resetText: input.fiveHourReset,
      },
      {
        windowName: "weekly",
        usedPct: Math.max(0, Math.min(100, 100 - input.weeklyRemainingPct)),
        remainingPct: input.weeklyRemainingPct,
        resetText: input.weeklyReset,
      },
      {
        windowName: "credits",
        usedPct: Math.max(0, input.creditsRemaining),
      },
    ],
    poolId,
    "manual_codex",
    0.95,
    now,
  );

  return snapshots.map((snapshot) => ({
    ...snapshot,
    idempotencyKey: snapshot.idempotencyKey.replace("manual_codex", `manual_codex-${now.getTime()}`),
  }));
}

function buildDetectionSnapshots(poolId: string, confidence: number, now: Date): QuotaPoolSnapshot[] {
  const h5w = hourlyWindow(now);
  const ww = weeklyWindow(now);
  const mw = monthlyWindow(now);
  const dateKey = now.toISOString().slice(0, 13);

  return [
    {
      quotaPoolId: poolId,
      windowName: "codex-5h",
      usageAmount: USAGE_UNKNOWN,
      windowStart: h5w.start.toISOString(),
      windowEnd: h5w.end.toISOString(),
      idempotencyKey: `codex-${poolId}-5h-detect-${dateKey}`,
      source: "detected",
      confidence,
    },
    {
      quotaPoolId: poolId,
      windowName: "codex-weekly",
      usageAmount: USAGE_UNKNOWN,
      windowStart: ww.start.toISOString(),
      windowEnd: ww.end.toISOString(),
      idempotencyKey: `codex-${poolId}-weekly-detect-${dateKey}`,
      source: "detected",
      confidence,
    },
    {
      quotaPoolId: poolId,
      windowName: "codex-credits",
      usageAmount: USAGE_UNKNOWN,
      windowStart: mw.start.toISOString(),
      windowEnd: mw.end.toISOString(),
      idempotencyKey: `codex-${poolId}-credits-detect-${dateKey}`,
      source: "detected",
      confidence,
    },
  ];
}

// ── Main Collector ─────────────────────────────────────────────

export async function collectCodex(): Promise<CodexCollectorResult> {
  const now = new Date();
  const config = readCodexConfig();

  if (!config) {
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

  const { confidence: modelConfidence, poolId } = classifyModel(config.model);

  // Priority 1: Try CLI status (PTY)
  let usageResult = await readCodexStatusUsage();

  // Priority 2: Try experimental browser (only if explicitly enabled)
  if (!usageResult && isExperimentalBrowserEnabled()) {
    usageResult = await collectBrowserUsage();
  }

  // Build snapshots
  const snapshots: QuotaPoolSnapshot[] = usageResult
    ? buildSnapshots(usageResult.windows, poolId, usageResult.source, usageResult.confidence, now)
    : buildDetectionSnapshots(poolId, modelConfidence, now);

  const toolInfos: ToolInfo[] = [
    {
      toolType: "codex",
      displayName: "Codex CLI",
      agentFingerprint: `codex-${deriveFingerprint()}`,
      metadata: JSON.stringify({
        detected: true,
        model: config.model,
        usageSource: usageResult?.source ?? "detected",
        hasRealUsage: !!usageResult,
        windows: usageResult?.windows.map((w) => w.windowName) ?? [],
        browserEnabled: isExperimentalBrowserEnabled(),
      }),
    },
  ];

  const rawMetadata: Record<string, unknown> = {
    model: config.model,
    toolType: "codex",
    usageSource: usageResult?.source ?? "detected",
    hasRealUsage: !!usageResult,
    browserEnabled: isExperimentalBrowserEnabled(),
  };

  const result: CodexCollectorResult = { snapshots, toolInfos, rawMetadata };
  return sanitize(result) as CodexCollectorResult;
}
