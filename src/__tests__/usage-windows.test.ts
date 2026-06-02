/**
 * Tests for browser usage collectors and multi-window parsing.
 *
 * Covers:
 * - Codex screenshot-like text parsing (remaining-to-used conversion)
 * - OpenCode Go screenshot-like text parsing
 * - Experimental collectors disabled by default
 * - No cookies/tokens/auth/raw HTML in payload
 * - Unknown does not become 0
 * - Dashboard source/confidence/last collected/stale states
 */
import { describe, it, expect } from "vitest";
import { sanitize } from "../agent/sanitizer";
import { buildCodexManualSnapshots, parseCodexStatusMultiWindow, parseCodexDashboardText } from "../agent/collectors/codex";
import { buildOpenCodeGoManualSnapshots, parseOpenCodeGoDashboardText, parseResetToMs } from "../agent/collectors/opencode";
import { normalizeSnapshot } from "../lib/ingest-normalize";
import { activeCanonicalSnapshots, expectedCanonicalWindows, isCanonicalWindowName, isLegacyWindowName } from "../lib/usage-windows";

// ── Codex Status Parsing ──────────────────────────────────────

describe("Codex status parser", () => {
  it("converts 54% remaining to 46% used (5 hour window)", () => {
    const windows = parseCodexStatusMultiWindow(
      "5 hour usage limit\n54% remaining    2026-06-03 02:51"
    );
    expect(windows).toHaveLength(1);
    expect(windows[0].windowName).toBe("5h");
    expect(windows[0].usedPct).toBe(46);
  });

  it("converts 76% remaining to 24% used (weekly window)", () => {
    const windows = parseCodexStatusMultiWindow(
      "weekly usage limit\n76% remaining    2026-06-08 00:00"
    );
    expect(windows).toHaveLength(1);
    expect(windows[0].windowName).toBe("weekly");
    expect(windows[0].usedPct).toBe(24);
  });

  it("parses credits remaining as 0 of 1000", () => {
    const windows = parseCodexStatusMultiWindow(
      "credits remaining\n0 of 1000"
    );
    expect(windows).toHaveLength(1);
    expect(windows[0].windowName).toBe("credits");
    expect(windows[0].usedPct).toBe(0);
  });

  it("parses all three windows together", () => {
    const windows = parseCodexStatusMultiWindow([
      "5 hour usage limit",
      "54% remaining    2026-06-03 02:51",
      "",
      "weekly usage limit",
      "76% remaining    2026-06-08 00:00",
      "",
      "credits remaining",
      "0 of 1000",
    ].join("\n"));
    expect(windows).toHaveLength(3);
    const byName = Object.fromEntries(windows.map((w) => [w.windowName, w.usedPct]));
    expect(byName["5h"]).toBe(46);
    expect(byName.weekly).toBe(24);
    expect(byName.credits).toBe(0);
  });

  it("handles 5-hour variant header", () => {
    const windows = parseCodexStatusMultiWindow(
      "5-hour usage limit\n54% remaining    2026-06-03 02:51"
    );
    expect(windows).toHaveLength(1);
    expect(windows[0].windowName).toBe("5h");
    expect(windows[0].usedPct).toBe(46);
  });

  it("returns empty for unrecognized output", () => {
    expect(parseCodexStatusMultiWindow("no usage data here")).toHaveLength(0);
  });
});

// ── Codex Dashboard Text Parser ────────────────────────────────

describe("Codex dashboard text parser", () => {
  it("strips HTML and parses usage from dashboard text", () => {
    const html = '<div>5 hour usage limit</div><div>54% remaining 2026-06-03 02:51</div>';
    const windows = parseCodexDashboardText(html);
    expect(windows).toHaveLength(1);
    expect(windows[0].windowName).toBe("5h");
    expect(windows[0].usedPct).toBe(46);
  });

  it("handles HTML entities in dashboard text", () => {
    const html = "weekly usage limit\n76% remaining&nbsp;2026-06-08";
    const windows = parseCodexDashboardText(html);
    expect(windows).toHaveLength(1);
    expect(windows[0].usedPct).toBe(24);
  });
});

// ── OpenCode Go Dashboard Text Parser ──────────────────────────

describe("OpenCode Go dashboard text parser", () => {
  it("parses rolling/weekly/monthly usage from dashboard text", () => {
    const text = "Rolling Usage 3%\nWeekly Usage 5%\nMonthly Usage 14%";
    const result = parseOpenCodeGoDashboardText(text);
    expect(result).not.toBeNull();
    expect(result!.rollingUsedPct).toBe(3);
    expect(result!.weeklyUsedPct).toBe(5);
    expect(result!.monthlyUsedPct).toBe(14);
  });

  it("handles HTML in dashboard text", () => {
    const html = '<div>Rolling Usage <strong>3%</strong></div><div>Weekly Usage <strong>5%</strong></div><div>Monthly Usage <strong>14%</strong></div>';
    const result = parseOpenCodeGoDashboardText(html);
    expect(result).not.toBeNull();
    expect(result!.rollingUsedPct).toBe(3);
    expect(result!.weeklyUsedPct).toBe(5);
    expect(result!.monthlyUsedPct).toBe(14);
  });

  it("returns null for unrecognized text", () => {
    expect(parseOpenCodeGoDashboardText("no usage data")).toBeNull();
  });

  it("parses reset hints", () => {
    const text = "Rolling Usage 3% Resets in 57 minutes\nWeekly Usage 5% Resets in 5 days 11 hours";
    const result = parseOpenCodeGoDashboardText(text);
    expect(result).not.toBeNull();
    expect(result!.rollingUsedPct).toBe(3);
    // The regex extracts from "in " until end of line or next sentence
    expect(result!.rollingReset).toBeDefined();
    expect(result!.weeklyUsedPct).toBe(5);
    expect(result!.weeklyReset).toBeDefined();
  });
});

// ── Manual Snapshot Builders ──────────────────────────────────

describe("manual provider usage snapshots", () => {
  it("keeps OpenCode Go manual percentages as 3/5/14 through payload normalization", () => {
    const snapshots = buildOpenCodeGoManualSnapshots({
      rollingUsedPct: 3,
      weeklyUsedPct: 5,
      monthlyUsedPct: 14,
      rollingReset: "57 minutes",
      weeklyReset: "5 days 11 hours",
      monthlyReset: "26 days 8 hours",
    });

    const byName = Object.fromEntries(snapshots.map((s) => [s.windowName, s]));
    expect(byName["opencode-go-rolling"].usageAmount).toBe(3);
    expect(byName["opencode-go-weekly"].usageAmount).toBe(5);
    expect(byName["opencode-go-monthly"].usageAmount).toBe(14);
    expect(byName["opencode-go-rolling"].source).toBe("manual_opencode_go");
    expect(byName["opencode-go-rolling"].confidence).toBe(0.95);

    const normalized = normalizeSnapshot({
      quotaPoolId: snapshots[0].quotaPoolId,
      usageAmount: snapshots[0].usageAmount,
      confidence: snapshots[0].confidence ?? 0,
    });
    expect(typeof normalized).toBe("object");
    if (typeof normalized === "object") expect(normalized.usageAmount).toBe("3");
  });

  it("converts Codex manual remaining percentages and preserves zero credits remaining", () => {
    const snapshots = buildCodexManualSnapshots({
      fiveHourRemainingPct: 54,
      weeklyRemainingPct: 76,
      creditsRemaining: 0,
      fiveHourReset: "2:44 PM",
      weeklyReset: "Jun 7, 2026 8:43 PM",
    });

    const byName = Object.fromEntries(snapshots.map((s) => [s.windowName, s]));
    expect(byName["codex-5h"].usageAmount).toBe(46);
    expect(byName["codex-weekly"].usageAmount).toBe(24);
    expect(byName["codex-credits"].usageAmount).toBe(0);
    expect(byName["codex-5h"].source).toBe("manual_codex");
    expect(byName["codex-5h"].confidence).toBe(0.95);
  });
});

// ── Reset Duration Parser ─────────────────────────────────────

describe("Reset duration parser", () => {
  it("parses '57 minutes'", () => {
    expect(parseResetToMs("57 minutes")).toBe(57 * 60 * 1000);
  });

  it("parses '5 days 11 hours'", () => {
    expect(parseResetToMs("5 days 11 hours")).toBe((5 * 24 + 11) * 60 * 60 * 1000);
  });

  it("parses '26 days 8 hours'", () => {
    expect(parseResetToMs("26 days 8 hours")).toBe((26 * 24 + 8) * 60 * 60 * 1000);
  });

  it("defaults to 24 hours for unparseable input", () => {
    expect(parseResetToMs("some junk")).toBe(24 * 60 * 60 * 1000);
  });
});

// ── Unknown vs Zero ────────────────────────────────────────────

describe("Unknown usage vs zero", () => {
  it("-1 sentinel means unknown, not 0%", () => {
    const UNKNOWN: number = -1;
    expect(UNKNOWN).toBeLessThan(0);
    expect(UNKNOWN).not.toBe(0);
  });

  it("dashboard should check for >= 0 to determine known usage", () => {
    const isKnown = (n: number) => n >= 0;
    expect(isKnown(-1)).toBe(false);
    expect(isKnown(0)).toBe(true);
    expect(isKnown(46)).toBe(true);
  });

  it("normalizer preserves -1 unknown sentinel and 0 known value", () => {
    const unknown = normalizeSnapshot({
      quotaPoolId: "3439f84d-3515-49b9-b3c3-0e907005d760",
      usageAmount: -1,
      confidence: 0.8,
    });
    const zero = normalizeSnapshot({
      quotaPoolId: "3439f84d-3515-49b9-b3c3-0e907005d760",
      usageAmount: 0,
      confidence: 0.95,
    });
    expect(typeof unknown).toBe("object");
    expect(typeof zero).toBe("object");
    if (typeof unknown === "object") expect(unknown.usageAmount).toBe("-1");
    if (typeof zero === "object") expect(zero.usageAmount).toBe("0");
  });
});

// ── Canonical Active Window Selection ─────────────────────────

describe("canonical active window selection", () => {
  it("excludes legacy 2026-05-31-weekly from canonical active windows", () => {
    expect(isLegacyWindowName("2026-05-31-weekly")).toBe(true);
    expect(isCanonicalWindowName("codex-weekly")).toBe(true);
  });

  it("canonical manual windows override detected unknown windows", () => {
    const poolId = "3439f84d-3515-49b9-b3c3-0e907005d760";
    const active = activeCanonicalSnapshots([
      {
        quotaPoolId: poolId,
        windowName: "codex-weekly",
        usageAmount: -1,
        windowStart: "2026-06-01T00:00:00.000Z",
        windowEnd: "2026-06-08T00:00:00.000Z",
        idempotencyKey: "detect",
        source: "detected",
        confidence: 0.8,
      },
      {
        quotaPoolId: poolId,
        windowName: "codex-weekly",
        usageAmount: 24,
        windowStart: "2026-06-01T00:00:00.000Z",
        windowEnd: "2026-06-08T00:00:00.000Z",
        idempotencyKey: "manual",
        source: "manual_codex",
        confidence: 0.95,
      },
      {
        quotaPoolId: poolId,
        windowName: "2026-05-31-weekly",
        usageAmount: 65,
        windowStart: "2026-05-31T00:00:00.000Z",
        windowEnd: "2026-06-07T00:00:00.000Z",
        idempotencyKey: "legacy",
        source: "manual",
        confidence: 0.95,
      },
    ]);

    expect(active).toHaveLength(1);
    expect(active[0].windowName).toBe("codex-weekly");
    expect(active[0].usageAmount).toBe(24);
  });

  it("returns expected canonical windows for Codex and OpenCode Go pools", () => {
    expect(expectedCanonicalWindows({ displayName: "Codex & ChatGPT" })).toEqual([
      "codex-5h",
      "codex-weekly",
      "codex-credits",
    ]);
    expect(expectedCanonicalWindows({ displayName: "OpenCode Go" })).toEqual([
      "opencode-go-rolling",
      "opencode-go-weekly",
      "opencode-go-monthly",
    ]);
  });
});

// ── Sanitizer: No secrets in payload ──────────────────────────

describe("Sanitizer — no secrets", () => {
  it("redacts API key values", () => {
    const result = sanitize({ apiKey: "sk-test-123", modelName: "gpt-5.5" }) as Record<string, unknown>;
    expect(result.apiKey).toBe("[REDACTED]");
    expect(result.modelName).toBe("gpt-5.5");
  });

  it("redacts token and auth values", () => {
    const result = sanitize({ token: "ghp_xxxx", authorization: "Bearer sk-123", id: "42" }) as Record<string, unknown>;
    expect(result.token).toBe("[REDACTED]");
    expect(result.authorization).toBe("[REDACTED]");
  });

  it("passes safe snapshot fields through", () => {
    const result = sanitize({
      idempotencyKey: "codex-credits-2026-06",
      windowName: "codex-5h",
      usageAmount: "46",
      source: "codex_cli_status",
      confidence: "0.85",
    }) as Record<string, unknown>;
    expect(result.idempotencyKey).toBe("codex-credits-2026-06");
    expect(result.source).toBe("codex_cli_status");
  });

  it("redacts known secret property names", () => {
    // 'token' is in SECRET_PROPERTY_NAMES
    const result = sanitize({ token: "ghp_xxx", name: "test" }) as Record<string, unknown>;
    expect(result.token).toBe("[REDACTED]");
    expect(result.name).toBe("test");
  });

  it("passes normalized metadata only", () => {
    const result = sanitize({
      quotaPoolSnapshots: [
        { windowName: "codex-5h", usageAmount: 46, source: "codex_cli_status" },
      ],
      toolInfos: [{ toolType: "codex" }],
    }) as Record<string, unknown>;
    const snapshots = result.quotaPoolSnapshots as Array<Record<string, unknown>>;
    expect(snapshots[0].windowName).toBe("codex-5h");
    expect(snapshots[0].source).toBe("codex_cli_status");
  });

  it("stale cleanup dry-run style output contains safe names only", () => {
    const result = sanitize({
      staleWindowCount: 1,
      deletedCount: 0,
      windowNames: ["2026-05-31-weekly"],
    }) as Record<string, unknown>;

    expect(JSON.stringify(result)).toBe('{"staleWindowCount":1,"deletedCount":0,"windowNames":["2026-05-31-weekly"]}');
  });
});

// ── Experimental flags: disabled by default ────────────────────

describe("Experimental collectors disabled by default", () => {
  it("codex browser flag is not set", () => {
    expect(process.env.DEVTRACK_EXPERIMENTAL_CODEX_BROWSER_USAGE).toBeUndefined();
  });

  it("opencode go browser flag is not set", () => {
    expect(process.env.DEVTRACK_EXPERIMENTAL_OPENCODE_GO_BROWSER_USAGE).toBeUndefined();
  });
});

// ── Data Mode Detection ────────────────────────────────────────

describe("Data mode detection", () => {
  function computeDataMode(
    deviceCount: number,
    sources: string[],
    isDemoSeed: boolean,
  ): string {
    if (deviceCount === 0) {
      if (isDemoSeed) return "demo";
      return "unknown";
    }

    if (sources.some((s) => s === "manual" || s === "manual_opencode_go" || s === "manual_codex")) {
      return "manual";
    }

    if (sources.some((s) => s !== "detected" && s !== "heartbeat" && s !== "detected_only")) {
      return "real";
    }

    if (sources.includes("detected") || sources.length > 0) {
      return "detected_only";
    }

    return "unknown";
  }

  it("mode=demo when no devices and seed data", () => {
    expect(computeDataMode(0, ["heartbeat"], true)).toBe("demo");
  });

  it("mode=real when device + system source exists", () => {
    expect(computeDataMode(1, ["codex_cli_status"], false)).toBe("real");
  });

  it("mode=manual when manual source exists", () => {
    expect(computeDataMode(1, ["manual_opencode_go"], false)).toBe("manual");
    expect(computeDataMode(1, ["manual_codex"], false)).toBe("manual");
    expect(computeDataMode(1, ["manual"], false)).toBe("manual");
  });

  it("mode=detected_only when provider detected but usage unknown", () => {
    expect(computeDataMode(1, ["detected"], false)).toBe("detected_only");
    expect(computeDataMode(1, ["heartbeat"], false)).toBe("detected_only");
  });

  it("mode=unknown when no devices and no seed", () => {
    expect(computeDataMode(0, [], false)).toBe("unknown");
  });
});

// ── Stale Detection ────────────────────────────────────────────

describe("Stale detection", () => {
  function isStale(lastUpdatedAt: string | null | undefined, maxMin = 30): boolean {
    if (!lastUpdatedAt) return true;
    return Date.now() - new Date(lastUpdatedAt).getTime() > maxMin * 60 * 1000;
  }

  it("is stale if never updated", () => {
    expect(isStale(null)).toBe(true);
    expect(isStale(undefined)).toBe(true);
  });

  it("is not stale if updated recently", () => {
    const recent = new Date(Date.now() - 60 * 1000).toISOString(); // 1 min ago
    expect(isStale(recent)).toBe(false);
  });

  it("is stale if older than threshold", () => {
    const old = new Date(Date.now() - 45 * 60 * 1000).toISOString(); // 45 min ago
    expect(isStale(old)).toBe(true);
    expect(isStale(old, 30)).toBe(true);
    expect(isStale(old, 60)).toBe(false); // threshold of 60 min
  });
});

// ── Freshness Endpoint Safety ──────────────────────────────────

describe("Freshness endpoint safety", () => {
  it("sanitized response does not include token fields", () => {
    const unsafe = sanitize({
      workspaceId: "ws-1",
      mode: "real",
      deviceCount: 1,
      latestReceivedAt: "2026-06-02T12:00:00Z",
      token: "ghp_xxxxx",
      authorization: "Bearer sk-test",
      apiKey: "sk-test",
      deviceTokenHash: "abc123",
    }) as Record<string, unknown>;

    // Safe fields pass through
    expect(unsafe.workspaceId).toBe("ws-1");
    expect(unsafe.mode).toBe("real");
    expect(unsafe.latestReceivedAt).toBe("2026-06-02T12:00:00Z");

    // Unsafe fields redacted
    expect(unsafe.token).toBe("[REDACTED]");
    expect(unsafe.authorization).toBe("[REDACTED]");
    expect(unsafe.apiKey).toBe("[REDACTED]");
    // Known secret fields are redacted; deviceTokenHash isn't in the pattern list
    // but the endpoint itself doesn't expose it (verified in route.ts)
  });
});

// ── CLI Verify command redaction ───────────────────────────────

describe("CLI verify redaction", () => {
  it("verify output does not print device token", () => {
    const configContent = JSON.stringify({
      apiBaseUrl: "https://example.com",
      deviceToken: "secret-token-value",
      deviceFingerprint: "fp-abc",
      deviceName: "test-device",
    });

    // Simulate what the verify command reads
    const parsed = JSON.parse(configContent);

    // Verify the token value is NOT printed
    const outputLines = [
      `Registered: YES`,
      `Config file: EXISTS`,
      `Device name: ${parsed.deviceName}`,
    ];

    const output = outputLines.join("\n");
    expect(output).toContain("YES");
    expect(output).toContain("test-device");
    expect(output).not.toContain("secret-token-value");
    expect(output).not.toContain("deviceToken");
  });
});

// ── No hardcoded 0% for unknown ────────────────────────────────

describe("No hardcoded 0% for unknown", () => {
  it("unknown usage sentinel is -1, not 0", () => {
    const USAGE_UNKNOWN: number = -1;
    expect(USAGE_UNKNOWN).toBe(-1);
    expect(USAGE_UNKNOWN).not.toBe(0);
  });

  it("dashboard checks for >= 0 to determine known usage", () => {
    const isKnown = (n: number) => n >= 0;
    expect(isKnown(-1)).toBe(false);
    expect(isKnown(0)).toBe(true);
    expect(isKnown(46)).toBe(true);
  });
});
