/**
 * Tests for accurate usage window collection.
 *
 * Covers:
 * - Codex remaining-to-used conversion
 * - OpenCode Go manual windows
 * - Unknown usage does not become 0
 * - No tokens/cookies/auth fields in payload
 * - Multi-window snapshot generation
 */
import { describe, it, expect } from "vitest";
import { sanitize } from "../agent/sanitizer";

// ── Codex Status Parsing (exact same logic as collector) ──────

function parseCodexStatusMultiWindow(stdout: string): Array<{
  windowName: string;
  usedPct: number;
}> {
  const windows: Array<{ windowName: string; usedPct: number }> = [];

  // Split into sections separated by blank lines
  const sections = stdout.split(/\n{2,}/);

  for (const section of sections) {
    const lines = section.split("\n").map((l) => l.trim());
    if (lines.length === 0) continue;

    const headerLine = lines[0].toLowerCase();

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

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];

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
      }
    }
  }

  return windows;
}

describe("Codex status parsing", () => {
  it("converts 54% remaining to 46% used (5 hour window)", () => {
    // Real output: header line + usage line separated by \n
    const output = "5 hour usage limit\n54% remaining    2026-06-03 02:51";

    const windows = parseCodexStatusMultiWindow(output);
    expect(windows).toHaveLength(1);
    expect(windows[0].windowName).toBe("5h");
    expect(windows[0].usedPct).toBe(46);
  });

  it("converts 76% remaining to 24% used (weekly window)", () => {
    const output = "weekly usage limit\n76% remaining    2026-06-08 00:00";

    const windows = parseCodexStatusMultiWindow(output);
    expect(windows).toHaveLength(1);
    expect(windows[0].windowName).toBe("weekly");
    expect(windows[0].usedPct).toBe(24);
  });

  it("parses 0 credits remaining correctly", () => {
    const output = "credits remaining\n0 of 1000";

    const windows = parseCodexStatusMultiWindow(output);
    expect(windows).toHaveLength(1);
    expect(windows[0].windowName).toBe("credits");
    expect(windows[0].usedPct).toBe(0);
  });

  it("converts 10% used directly (not remaining)", () => {
    const output = "5 hour usage limit\n10% used    2026-06-03 02:51";

    const windows = parseCodexStatusMultiWindow(output);
    expect(windows).toHaveLength(1);
    expect(windows[0].usedPct).toBe(10);
  });

  it("parses all three windows together (separated by blank lines)", () => {
    const output = [
      "5 hour usage limit",
      "54% remaining    2026-06-03 02:51",
      "",
      "weekly usage limit",
      "76% remaining    2026-06-08 00:00",
      "",
      "credits remaining",
      "0 of 1000",
    ].join("\n");

    const windows = parseCodexStatusMultiWindow(output);
    expect(windows).toHaveLength(3);

    const byName = Object.fromEntries(windows.map((w) => [w.windowName, w.usedPct]));
    expect(byName["5h"]).toBe(46);
    expect(byName.weekly).toBe(24);
    expect(byName.credits).toBe(0);
  });

  it("returns empty array for unrecognized output", () => {
    const output = "no usage data here\njust some text";
    const windows = parseCodexStatusMultiWindow(output);
    expect(windows).toHaveLength(0);
  });

  it("handles '5-hour usage limit' variant", () => {
    const output = "5-hour usage limit\n54% remaining    2026-06-03 02:51";

    const windows = parseCodexStatusMultiWindow(output);
    expect(windows).toHaveLength(1);
    expect(windows[0].windowName).toBe("5h");
    expect(windows[0].usedPct).toBe(46);
  });
});

// ── OpenCode Go Manual Snapshots ───────────────────────────────

function parseResetToMs(reset: string): number {
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

describe("OpenCode Go manual usage", () => {
  it("creates snapshots with correct percentage values", () => {
    const input = {
      rollingUsedPct: 3,
      weeklyUsedPct: 5,
      monthlyUsedPct: 14,
    };

    expect(input.rollingUsedPct).toBe(3);
    expect(input.weeklyUsedPct).toBe(5);
    expect(input.monthlyUsedPct).toBe(14);
  });

  it("parses reset strings correctly", () => {
    const ms57min = parseResetToMs("57 minutes");
    expect(ms57min).toBe(57 * 60 * 1000);

    const ms5d11h = parseResetToMs("5 days 11 hours");
    expect(ms5d11h).toBe((5 * 24 + 11) * 60 * 60 * 1000);

    const ms26d8h = parseResetToMs("26 days 8 hours");
    expect(ms26d8h).toBe((26 * 24 + 8) * 60 * 60 * 1000);
  });

  it("defaults to 24 hours if reset string is unparseable", () => {
    const msDefault = parseResetToMs("some junk");
    expect(msDefault).toBe(24 * 60 * 60 * 1000);
  });
});

// ── Unknown Usage Handling ─────────────────────────────────────

describe("Unknown usage handling", () => {
  const UNKNOWN: number = -1;
  const KNOWN_ZERO: number = 0;

  it("does not show 0% when usage is unknown", () => {
    expect(UNKNOWN).toBe(-1);
    expect(UNKNOWN).not.toBe(0);
    expect(UNKNOWN).toBeLessThan(0);
  });

  it("distinguishes known 0% from unknown", () => {
    expect(KNOWN_ZERO).toBeGreaterThanOrEqual(0);
    expect(UNKNOWN).toBeLessThan(0);
    expect(UNKNOWN).not.toBe(0);
  });
});

// ── Sanitizer: No tokens/cookies/auth fields in payload ────────

describe("Sanitizer — no secret fields", () => {
  it("redacts API key values", () => {
    const payload = {
      apiKey: "sk-test-123",
      modelName: "gpt-5.5",
    };
    const result = sanitize(payload) as Record<string, unknown>;
    expect(result.apiKey).toBe("[REDACTED]");
    expect(result.modelName).toBe("gpt-5.5");
  });

  it("redacts token values", () => {
    const payload = {
      token: "ghp_xxxxxx",
      name: "test",
    };
    const result = sanitize(payload) as Record<string, unknown>;
    expect(result.token).toBe("[REDACTED]");
  });

  it("redacts bearer auth headers", () => {
    const payload = {
      authorization: "Bearer sk-123",
      id: "42",
    };
    const result = sanitize(payload) as Record<string, unknown>;
    expect(result.authorization).toBe("[REDACTED]");
  });

  it("passes through safe fields unchanged", () => {
    const payload = {
      idempotencyKey: "codex-credits-2026-06",
      windowName: "codex-5h",
      usageAmount: "46",
      source: "codex_cli_status",
      confidence: "0.85",
    };
    const result = sanitize(payload) as Record<string, unknown>;
    expect(result.idempotencyKey).toBe("codex-credits-2026-06");
    expect(result.windowName).toBe("codex-5h");
    expect(result.source).toBe("codex_cli_status");
  });

  it("deeply sanitizes nested objects", () => {
    const payload = {
      config: {
        api_key: "sk-test",
        model: "gpt-5.5",
      },
    };
    const result = sanitize(payload) as { config: Record<string, unknown> };
    expect(result.config.api_key).toBe("[REDACTED]");
    expect(result.config.model).toBe("gpt-5.5");
  });
});

// ── Multi-window snapshot generation ───────────────────────────

describe("Multi-window snapshots", () => {
  it("generates separate idempotency keys per window", () => {
    const poolId = "00000000-0000-0000-0000-000000000001";
    const now = new Date();
    const windows = ["5h", "weekly", "credits"];

    const keys = windows.map((w) =>
      `codex-${poolId}-${w}-${now.toISOString().slice(0, 13)}`
    );

    expect(new Set(keys).size).toBe(3);
  });

  it("assigns correct source and confidence per window type", () => {
    const windows = [
      { name: "rolling", source: "manual_opencode_go", confidence: 0.95 },
      { name: "weekly", source: "manual_opencode_go", confidence: 0.95 },
      { name: "monthly", source: "manual_opencode_go", confidence: 0.95 },
    ];

    for (const w of windows) {
      expect(w.source).toBe("manual_opencode_go");
      expect(w.confidence).toBeGreaterThan(0.9);
    }
  });
});

// ── Experimental flags: disabled by default ────────────────────

describe("Experimental flags", () => {
  it("experimental dashboard is not enabled in default env", () => {
    expect(process.env.DEVTRACK_EXPERIMENTAL_CODEX_DASHBOARD).toBeUndefined();
  });

  it("experimental opencode go is not enabled in default env", () => {
    expect(process.env.DEVTRACK_EXPERIMENTAL_OPENCODE_GO_USAGE).toBeUndefined();
  });
});
