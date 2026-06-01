/**
 * sanitizer.test.ts — Privacy redaction tests for the sanitizer module.
 *
 * Tests cover:
 * - Raw token values (sk-*, tok_*, ghp_*) are redacted
 * - Secret property names (apiKey, api_secret, token, password) redact their value
 * - Normal data (usageAmount, windowName, displayName) passes through unchanged
 * - Deep nesting is handled (recursive)
 * - Array values are sanitized element-by-element
 * - Empty/null/undefined values pass through safely
 */
import { describe, it, expect } from "vitest";
import { sanitize, sanitizeJsonString, isSecretValue } from "../agent/sanitizer";

// ── Helpers ──────────────────────────────────────────────────────

function assertNotRedacted(value: unknown): void {
  if (typeof value === "string") {
    expect(value).not.toBe("[REDACTED]");
  }
}

// ── SECRET VALUE PATTERNS ───────────────────────────────────────

describe("sanitize — secret value redaction", () => {
  it("redacts OpenAI-style secret keys (sk-*)", () => {
    expect(sanitize("sk-pro...cdef")).toBe("[REDACTED]");
  });

  it("redacts Stripe-like tokens (tok_*)", () => {
    expect(sanitize("tok_visa_1234abcd5678efgh")).toBe("[REDACTED]");
  });

  it("redacts GitHub personal access tokens (ghp_*)", () => {
    expect(sanitize("ghp_fa...1234")).toBe("[REDACTED]");
  });

  it("redacts GitHub OAuth tokens (gho_*)", () => {
    expect(sanitize("gho_fa...1234")).toBe("[REDACTED]");
  });

  it("redacts GitHub user tokens (ghu_*)", () => {
    expect(sanitize("ghu_fa...1234")).toBe("[REDACTED]");
  });

  it("redacts Line API tokens (lin_api_*)", () => {
    expect(sanitize("lin_api_fake1234567890abcdef")).toBe("[REDACTED]");
  });

  it("redacts Slack tokens (xox[bpar]-)", () => {
    expect(sanitize("xoxb-f...cdef")).toBe("[REDACTED]");
    expect(sanitize("xoxp-f...cdef")).toBe("[REDACTED]");
    expect(sanitize("xoxa-2...cdef")).toBe("[REDACTED]");
    expect(sanitize("xoxr-f...cdef")).toBe("[REDACTED]");
  });

  it("redacts AWS access key IDs (AKIA*)", () => {
    expect(sanitize("AKIA0123456789ABCDEF")).toBe("[REDACTED]");
  });

  it("passes through safe strings unchanged", () => {
    const safe = "hello-world-normal-text";
    expect(sanitize(safe)).toBe(safe);
  });

  it("passes through usage amounts unchanged", () => {
    expect(sanitize("100.5")).toBe("100.5");
    expect(sanitize("0")).toBe("0");
    expect(sanitize("42")).toBe("42");
  });

  it("passes through window names unchanged", () => {
    const name = "2026-06-monthly";
    expect(sanitize(name)).toBe(name);
  });

  it("passes through display names unchanged", () => {
    const name = "Codex CLI";
    expect(sanitize(name)).toBe(name);
  });
});

// ── SECRET PROPERTY NAMES ───────────────────────────────────────

describe("sanitize — secret property name redaction", () => {
  it("redacts apiKey property value", () => {
    const input = { apiKey: "***" };
    const result = sanitize(input);
    expect(result.apiKey).toBe("[REDACTED]");
  });

  it("redacts api_secret property value", () => {
    const input = { api_secret: "my-super-secret" };
    const result = sanitize(input);
    expect(result.api_secret).toBe("[REDACTED]");
  });

  it("redacts token property value", () => {
    const input = { token: "some-auth-token-value" };
    const result = sanitize(input);
    expect(result.token).toBe("[REDACTED]");
  });

  it("redacts password property value", () => {
    const input = { password: "hunter2" };
    const result = sanitize(input);
    expect(result.password).toBe("[REDACTED]");
  });

  it("redacts bearer property value", () => {
    const input = { bearer: "eyJhbG...VzdA" };
    const result = sanitize(input);
    expect(result.bearer).toBe("[REDACTED]");
  });

  it("redacts auth property value", () => {
    const input = { auth: "basic dXNlcjpwYXNz" };
    const result = sanitize(input);
    expect(result.auth).toBe("[REDACTED]");
  });

  it("redacts authorization property value", () => {
    const input = { authorization: "Bearer faketoken123" };
    const result = sanitize(input);
    expect(result.authorization).toBe("[REDACTED]");
  });

  it("redacts api-key (hyphenated) property value", () => {
    const input = { "api-key": "***" };
    const result = sanitize(input);
    expect(result["api-key"]).toBe("[REDACTED]");
  });

  it("redacts secretKey property value", () => {
    const input = { secretKey: "my-secret-value" };
    const result = sanitize(input);
    expect(result.secretKey).toBe("[REDACTED]");
  });

  it("redacts privateKey property value", () => {
    const input = { privateKey: "-----BEGIN RSA PRIVATE KEY-----" };
    const result = sanitize(input);
    expect(result.privateKey).toBe("[REDACTED]");
  });

  it("redacts accessKey property value", () => {
    const input = { accessKey: "AKIAFAKEKEY1234567" };
    const result = sanitize(input);
    expect(result.accessKey).toBe("[REDACTED]");
  });

  it("redacts access_secret property value", () => {
    const input = { access_secret: "some-secret-value" };
    const result = sanitize(input);
    expect(result.access_secret).toBe("[REDACTED]");
  });

  it("does NOT redact idempotencyKey value (safe field)", () => {
    const input = { idempotencyKey: "codex-Codex-ChatGPT-2026-06" };
    const result = sanitize(input);
    expect(result.idempotencyKey).toBe(input.idempotencyKey);
    assertNotRedacted(result.idempotencyKey);
  });

  it("passes through safe property names unchanged", () => {
    const input = {
      usageAmount: 42,
      windowName: "2026-06-monthly",
      displayName: "My Tool",
      confidence: 0.9,
      source: "heartbeat",
    };
    const result = sanitize(input);
    expect(result.usageAmount).toBe(42);
    expect(result.windowName).toBe("2026-06-monthly");
    expect(result.displayName).toBe("My Tool");
    expect(result.confidence).toBe(0.9);
    expect(result.source).toBe("heartbeat");
  });
});

// ── DEEP NESTING ─────────────────────────────────────────────────

describe("sanitize — deep nesting (recursion)", () => {
  it("redacts deeply nested token values", () => {
    const input = {
      level1: {
        level2: {
          level3: {
            apiKey: "sk-nes...cret",
          },
        },
      },
    };
    const result = sanitize(input);
    expect(result.level1.level2.level3.apiKey).toBe("[REDACTED]");
  });

  it("redacts deeply nested raw secret string", () => {
    const input = {
      outer: {
        inner: {
          value: "ghp_de...2345",
        },
      },
    };
    const result = sanitize(input);
    expect(result.outer.inner.value).toBe("[REDACTED]");
  });

  it("preserves safe deeply nested values", () => {
    const input = {
      a: {
        b: {
          c: {
            usageAmount: 100,
            name: "safe-deep-value",
          },
        },
      },
    };
    const result = sanitize(input);
    expect(result.a.b.c.usageAmount).toBe(100);
    expect(result.a.b.c.name).toBe("safe-deep-value");
  });
});

// ── ARRAYS ───────────────────────────────────────────────────────

describe("sanitize — arrays", () => {
  it("sanitizes array of secret strings element-by-element", () => {
    const input = ["sk-key1", "safe-value", "tok_abc123"];
    const result = sanitize(input);
    expect(result[0]).toBe("[REDACTED]");
    expect(result[1]).toBe("safe-value");
    expect(result[2]).toBe("[REDACTED]");
  });

  it("sanitizes array of objects with secret properties", () => {
    const input = [
      { name: "tool1", apiKey: "sk-tool1-key" },
      { name: "tool2", apiKey: "sk-tool2-key" },
    ];
    const result = sanitize(input);
    expect(result[0].name).toBe("tool1");
    expect(result[0].apiKey).toBe("[REDACTED]");
    expect(result[1].name).toBe("tool2");
    expect(result[1].apiKey).toBe("[REDACTED]");
  });

  it("sanitizes nested arrays (array in array)", () => {
    const input = [["sk-***"], ["safe"]];
    const result = sanitize(input);
    expect(result[0][0]).toBe("[REDACTED]");
    expect(result[1][0]).toBe("safe");
  });
});

// ── NULL / UNDEFINED / EMPTY ────────────────────────────────────

describe("sanitize — null/undefined/empty values", () => {
  it("passes through null values", () => {
    const input = { key: null };
    const result = sanitize(input);
    expect(result.key).toBeNull();
  });

  it("passes through undefined values", () => {
    const input = { key: undefined };
    const result = sanitize(input);
    expect(result.key).toBeUndefined();
  });

  it("passes through empty string", () => {
    const input = { key: "" };
    const result = sanitize(input);
    expect(result.key).toBe("");
  });

  it("handles null top-level value", () => {
    expect(sanitize(null)).toBeNull();
  });

  it("handles undefined top-level value", () => {
    expect(sanitize(undefined)).toBeUndefined();
  });

  it("handles empty object", () => {
    const result = sanitize({});
    expect(result).toEqual({});
  });

  it("handles empty array", () => {
    const result = sanitize([]);
    expect(result).toEqual([]);
  });

  it("handles numbers and booleans", () => {
    expect(sanitize(0)).toBe(0);
    expect(sanitize(42)).toBe(42);
    expect(sanitize(true)).toBe(true);
    expect(sanitize(false)).toBe(false);
  });

  it("handles mixed object with null and secret", () => {
    const input = { apiKey: null, token: undefined, name: "safe", secret: "sk-mixed" };
    const result = sanitize(input);
    expect(result.apiKey).toBeNull();
    expect(result.token).toBeUndefined();
    expect(result.name).toBe("safe");
    expect(result.secret).toBe("[REDACTED]"); // secret property name
  });
});

// ── SANITIZE JSON STRING ────────────────────────────────────────

describe("sanitizeJsonString", () => {
  it("parses and sanitizes a JSON string", () => {
    const raw = JSON.stringify({ apiKey: "sk-fake-key", name: "test" });
    const result = sanitizeJsonString(raw) as Record<string, unknown>;
    expect(result.apiKey).toBe("[REDACTED]");
    expect(result.name).toBe("test");
  });

  it("returns INVALID JSON marker for unparseable input", () => {
    const result = sanitizeJsonString("not valid json{{{");
    expect(result).toBe("[INVALID JSON — REDACTED]");
  });
});

// ── IS SECRET VALUE ─────────────────────────────────────────────

describe("isSecretValue", () => {
  it("returns true for sk-* patterns", () => {
    expect(isSecretValue("sk-pro...cdef")).toBe(true);
  });

  it("returns true for ghp_* patterns", () => {
    expect(isSecretValue("ghp_fakeToken")).toBe(true);
  });

  it("returns false for normal strings", () => {
    expect(isSecretValue("hello")).toBe(false);
    expect(isSecretValue("2026-06-monthly")).toBe(false);
  });
});
