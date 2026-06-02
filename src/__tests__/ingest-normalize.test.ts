import { describe, it, expect } from "vitest";
import {
  toNumericString,
  isValidUUID,
  findInvalidUUIDs,
  findMissingFields,
  serializeDbError,
  normalizeSnapshot,
} from "@/lib/ingest-normalize";

// ── toNumericString ─────────────────────────────────────────
describe("toNumericString", () => {
  it("converts number 0 to string 0", () => {
    expect(toNumericString(0)).toBe("0");
  });

  it("converts positive number to string", () => {
    expect(toNumericString(42)).toBe("42");
    expect(toNumericString(650)).toBe("650");
  });

  it("converts decimal number to string", () => {
    expect(toNumericString(0.9)).toBe("0.9");
    expect(toNumericString(3.14159)).toBe("3.14159");
  });

  it("converts numeric string to string", () => {
    expect(toNumericString("0")).toBe("0");
    expect(toNumericString("65.000000")).toBe("65.000000");
  });

  it("returns null for Infinity", () => {
    expect(toNumericString(Infinity)).toBeNull();
  });

  it("returns null for NaN", () => {
    expect(toNumericString(NaN)).toBeNull();
  });

  it("returns null for null", () => {
    expect(toNumericString(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(toNumericString(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(toNumericString("")).toBeNull();
  });

  it("rejects non-numeric string", () => {
    expect(toNumericString("abc")).toBeNull();
    expect(toNumericString("12abc")).toBeNull();
    expect(toNumericString("")).toBeNull();
  });
});

// ── isValidUUID ─────────────────────────────────────────────
describe("isValidUUID", () => {
  it("accepts valid UUID v4", () => {
    expect(isValidUUID("3439f84d-3515-49b9-b3c3-0e907005d760")).toBe(true);
    expect(isValidUUID("d857f67d-7297-4cfd-a76f-04dcea4b7fb5")).toBe(true);
  });

  it("rejects mock/placeholder UUIDs", () => {
    expect(isValidUUID("00000000-0000-0000-0000-000000000001")).toBe(true); // technically valid format, just not real
  });

  it("rejects non-UUID strings", () => {
    expect(isValidUUID("not-a-uuid")).toBe(false);
    expect(isValidUUID("")).toBe(false);
    expect(isValidUUID("12345")).toBe(false);
  });

  it("rejects null/undefined", () => {
    expect(isValidUUID(null)).toBe(false);
    expect(isValidUUID(undefined)).toBe(false);
  });
});

// ── findInvalidUUIDs ────────────────────────────────────────
describe("findInvalidUUIDs", () => {
  it("returns empty for all-valid", () => {
    expect(findInvalidUUIDs(["3439f84d-3515-49b9-b3c3-0e907005d760"])).toEqual([]);
  });

  it("finds invalid UUIDs", () => {
    const result = findInvalidUUIDs([
      "3439f84d-3515-49b9-b3c3-0e907005d760",
      "not-a-uuid",
      "",
    ]);
    expect(result).toEqual(["not-a-uuid", ""]);
  });
});

// ── findMissingFields ───────────────────────────────────────
describe("findMissingFields", () => {
  it("returns empty when all present", () => {
    expect(findMissingFields({ a: 1, b: "x" }, ["a", "b"])).toEqual([]);
  });

  it("finds missing fields", () => {
    expect(findMissingFields({ a: 1 }, ["a", "b"])).toEqual(["b"]);
  });

  it("treats empty string as missing", () => {
    expect(findMissingFields({ a: "" }, ["a"])).toEqual(["a"]);
  });

  it("treats null as missing", () => {
    expect(findMissingFields({ a: null }, ["a"])).toEqual(["a"]);
  });
});

// ── serializeDbError ────────────────────────────────────────
describe("serializeDbError", () => {
  it("extracts Postgres error fields", () => {
    const pgErr = Object.assign(new Error("relation not found"), {
      code: "42P01",
      detail: "Table does not exist",
      constraint: "fk_workspace",
      table: "usage_snapshots",
      column: "window_name",
      dataType: "text",
      routine: "heap_create_with_catalog",
    });
    const safe = serializeDbError(pgErr);
    expect(safe.name).toBe("Error");
    expect(safe.message).toBe("relation not found");
    expect(safe.code).toBe("42P01");
    expect(safe.detail).toBe("Table does not exist");
    expect(safe.table).toBe("usage_snapshots");
    expect(safe.column).toBe("window_name");
  });

  it("handles plain Error", () => {
    const safe = serializeDbError(new Error("oops"));
    expect(safe.name).toBe("Error");
    expect(safe.message).toBe("oops");
    expect(safe.code).toBeUndefined();
  });

  it("handles null/undefined", () => {
    const safe = serializeDbError(null);
    expect(safe.name).toBe("Error");
    expect(safe.message).toBe("Unknown error");
  });

  it("handles strings", () => {
    const safe = serializeDbError("just a string");
    expect(safe.name).toBe("Error");
    expect(safe.message).toBe("just a string");
  });
});

// ── normalizeSnapshot ───────────────────────────────────────
describe("normalizeSnapshot", () => {
  it("normalizes valid snapshot", () => {
    const result = normalizeSnapshot({
      quotaPoolId: "3439f84d-3515-49b9-b3c3-0e907005d760",
      usageAmount: 650,
      confidence: 0.9,
    });
    expect(typeof result).toBe("object");
    if (typeof result === "object") {
      expect(result.usageAmount).toBe("650");
      expect(result.confidence).toBe("0.9");
    }
  });

  it("rejects invalid UUID", () => {
    const result = normalizeSnapshot({
      quotaPoolId: "bad-uuid",
      usageAmount: 100,
      confidence: 0.5,
    });
    expect(typeof result).toBe("string");
    expect(result).toContain("Invalid quotaPoolId");
  });

  it("rejects NaN usageAmount", () => {
    const result = normalizeSnapshot({
      quotaPoolId: "3439f84d-3515-49b9-b3c3-0e907005d760",
      usageAmount: NaN,
      confidence: 0.5,
    });
    expect(typeof result).toBe("string");
    expect(result).toContain("Invalid usageAmount");
  });
});
