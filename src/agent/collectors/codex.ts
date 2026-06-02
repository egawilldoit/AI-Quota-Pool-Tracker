/**
 * Codex collector — detects local Codex CLI installation, reads safe model
 * metadata from ~/.codex/config.toml, and collects usage windows.
 *
 * COLLECTION PATHS (in priority order):
 *
 * A. Safe CLI path — `codex status` (requires TTY, may not work in cron)
 *    Parses multi-window output:
 *      - 5 hour usage limit: XX% remaining → usedPct = 100 - remainingPct
 *      - weekly usage limit: XX% remaining → usedPct = 100 - remainingPct
 *      - credits remaining: N → usedPct = totalAllocated - N (if known)
 *    source = "codex_cli_status", confidence = "confirmed"
 *
 * B. Detection fallback — model name from config.toml (always works)
 *    source = "detected", confidence = 0.7–0.9 (based on model)
 *    Emits usage_unknown — the dashboard shows "unknown" not fake 0%.
 *
 * C. Experimental dashboard path — gated by env flag:
 *    DEVTRACK_EXPERIMENTAL_CODEX_DASHBOARD=1
 *    (not implemented yet — browser auth path needs explicit opt-in)
 *
 * PRIVACY SAFEGUARDS:
 *   - Reads ONLY ~/.codex/config.toml (model name only)
 *   - NEVER reads ~/.codex/auth.json (contains tokens)
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
import { resolvePoolId } from "../pool-map";

const execFileAsync = promisify(execFile);

export interface CodexCollectorResult {
  snapshots: QuotaPoolSnapshot[];
  toolInfos: ToolInfo[];
  rawMetadata?: Record<string, unknown>;
}

/** Known paid-model prefixes that map to high-confidence usage. */
const PAID_MODEL_PREFIXES = ["gpt-", "o1", "o3", "o4"];

// ── Types ─────────────────────────────────────────────────────

interface CodexWindow {
  windowName: string;
  usedPct: number;
  resetText?: string;
}

interface CodexStatusResult {
  windows: CodexWindow[];
  source: string;
  confidence: number;
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

// ── Codex Status Parsing ──────────────────────────────────────

/**
 * Parse `codex status` text output for multi-window usage.
 *
 * Expected format (Codex latest):
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
 */
function parseCodexStatusMultiWindow(stdout: string): CodexWindow[] {
  const windows: CodexWindow[] = [];

  // Pattern: "5 hour usage limit" followed by a line with a percentage
  // or "5h usage limit" or "5-hour usage limit"
  const sections = stdout.split(/\n{2,}/);

  for (const section of sections) {
    const lines = section.split("\n").map((l) => l.trim());
    if (lines.length === 0) continue;

    const headerLine = lines[0].toLowerCase();

    // Determine window type from header
    let windowName: string | null = null;
    if (/5[-\s]?hour/i.test(headerLine) || /5h/i.test(headerLine)) {
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
          windows.push({ windowName, usedPct });
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
        // Try standalone number (credits remaining count)
        const numMatch = line.match(/^(\d+(?:\.\d+)?)/);
        if (numMatch && !pctMatch) {
          const remaining = Number(numMatch[1]);
          if (Number.isFinite(remaining)) {
            // We don't know total — store raw. Dashboard shows absolute.
            windows.push({ windowName, usedPct: remaining });
            break;
          }
        }
      }
    }

    // Try to extract reset time from the section
    const resetMatch = section.match(
      /(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/,
    );
    if (resetMatch && windows.length > 0) {
      windows[windows.length - 1].resetText = resetMatch[1];
    }
  }

  return windows;
}

/**
 * Try to collect usage via `codex status` (text output).
 */
async function readCodexStatusUsage(): Promise<CodexStatusResult | null> {
  const options = {
    timeout: 15_000,
    maxBuffer: 128 * 1024,
    env: { ...process.env },
  };

  // Try PTY-less status first (may fail with "stdin is not a terminal")
  try {
    const result = await execFileAsync("script", [
      "-q", "-c", "codex status 2>/dev/null", "/dev/null",
    ], { ...options, timeout: 20_000 });
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

  try {
    const result = await execFileAsync("codex", ["status"], {
      ...options,
      env: { ...process.env, TERM: "xterm-256color" },
    });
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

/**
 * Check if the experimental dashboard flag is set.
 */
function isExperimentalDashboardEnabled(): boolean {
  return process.env.DEVTRACK_EXPERIMENTAL_CODEX_DASHBOARD === "1";
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
  // Monday of current week
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

  // Attempt to collect real usage from codex status
  const statusResult = await readCodexStatusUsage();

  // Build window definitions
  const h5w = hourlyWindow(now);
  const ww = weeklyWindow(now);
  const mw = monthlyWindow(now);

  const snapshots: QuotaPoolSnapshot[] = [];

  if (statusResult) {
    // We have real usage windows from codex status
    for (const window of statusResult.windows) {
      let windowStart: Date;
      let windowEnd: Date;

      switch (window.windowName) {
        case "5h":
          windowStart = h5w.start;
          windowEnd = h5w.end;
          break;
        case "weekly":
          windowStart = ww.start;
          windowEnd = ww.end;
          break;
        case "monthly":
          windowStart = mw.start;
          windowEnd = mw.end;
          break;
        case "credits":
          windowStart = mw.start; // credits reset monthly-ish
          windowEnd = mw.end;
          break;
        default:
          windowStart = mw.start;
          windowEnd = mw.end;
      }

      snapshots.push({
        quotaPoolId: poolId,
        windowName: `codex-${window.windowName}`,
        usageAmount: window.usedPct,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        idempotencyKey: `codex-${poolId}-${window.windowName}-${now.toISOString().slice(0, 13)}`,
        source: statusResult.source,
        confidence: statusResult.confidence,
      });
    }
  } else {
    // No real usage data available — emit detection-only snapshots with usage_unknown
    // explicitly set to -1 to indicate "unknown" (not 0%)
    const USAGE_UNKNOWN = -1;

    // Always emit Codex detection windows so the dashboard knows Codex is installed
    for (const windowName of ["5h", "weekly", "credits"]) {
      let windowStart: Date;
      let windowEnd: Date;

      switch (windowName) {
        case "5h":
          windowStart = h5w.start;
          windowEnd = h5w.end;
          break;
        case "weekly":
          windowStart = ww.start;
          windowEnd = ww.end;
          break;
        case "credits":
          windowStart = mw.start;
          windowEnd = mw.end;
          break;
        default:
          windowStart = mw.start;
          windowEnd = mw.end;
      }

      snapshots.push({
        quotaPoolId: poolId,
        windowName: `codex-${windowName}`,
        usageAmount: USAGE_UNKNOWN,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        idempotencyKey: `codex-${poolId}-${windowName}-detect-${now.toISOString().slice(0, 13)}`,
        source: "detected",
        confidence: modelConfidence,
      });
    }
  }

  const usageStatus = statusResult ? "codex_cli_status" : "detected";
  const hasRealUsage = statusResult !== null;

  const toolInfos: ToolInfo[] = [
    {
      toolType: "codex",
      displayName: "Codex CLI",
      agentFingerprint: `codex-${deriveFingerprint()}`,
      metadata: JSON.stringify({
        detected: true,
        model: config.model,
        usageStatus,
        hasRealUsage,
        windows: statusResult?.windows.map((w) => w.windowName) ?? [],
      }),
    },
  ];

  const rawMetadata: Record<string, unknown> = {
    model: config.model,
    toolType: "codex",
    usageStatus,
    hasRealUsage,
    experimentalDashboardEnabled: isExperimentalDashboardEnabled(),
  };

  const result: CodexCollectorResult = {
    snapshots,
    toolInfos,
    rawMetadata,
  };

  return sanitize(result) as CodexCollectorResult;
}
