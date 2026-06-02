/**
 * Ingest normalization utilities — validates and normalizes data before DB insert.
 *
 * Handles:
 * - Numeric string conversion (postgres-js + Supabase pooler needs strings)
 * - UUID validation (reject bad UUIDs before they hit the DB)
 * - Missing required field detection
 * - Safe DB error serialization (no secrets/tokens/payload leak)
 */

// ── Numeric ────────────────────────────────────────────────────

/**
 * Convert a value to a numeric string suitable for numeric(20,6) columns.
 * Returns null for invalid/null/undefined/empty values.
 */
export function toNumericString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return value.toString();
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
    return trimmed;
  }
  return null;
}

// ── UUID ───────────────────────────────────────────────────────

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUUID(value: unknown): value is string {
  return typeof value === "string" && uuidRegex.test(value);
}

/**
 * Validate an array of UUIDs. Returns array of invalid ones.
 */
export function findInvalidUUIDs(ids: string[]): string[] {
  return ids.filter((id) => !isValidUUID(id));
}

// ── Required fields ────────────────────────────────────────────

/**
 * Check a record for required field presence. Returns array of missing field names.
 */
export function findMissingFields(
  obj: Record<string, unknown>,
  required: string[],
): string[] {
  return required.filter((field) => {
    const val = obj[field];
    return val === undefined || val === null || val === "";
  });
}

// ── DB Error Serialization (safe) ──────────────────────────────

export interface SafeDbError {
  name: string;
  message: string;
  code?: string;
  detail?: string;
  constraint?: string;
  table?: string;
  column?: string;
  dataType?: string;
  routine?: string;
}

/**
 * Safely serialize a DB error into a non-secret shape.
 * Does NOT include: SQL query text, parameter values, headers, tokens, env vars, payload.
 */
export function serializeDbError(error: unknown): SafeDbError {
  if (!error || typeof error !== "object") {
    return { name: "Error", message: String(error ?? "Unknown error") };
  }
  const e = error as Record<string, unknown>;
  return {
    name: typeof e.name === "string" ? e.name : "Error",
    message: typeof e.message === "string" ? e.message : String(error),
    code: typeof e.code === "string" ? e.code : undefined,
    detail: typeof e.detail === "string" ? e.detail : undefined,
    constraint: typeof e.constraint === "string" ? e.constraint : undefined,
    table: typeof e.table === "string" ? e.table : undefined,
    column: typeof e.column === "string" ? e.column : undefined,
    dataType: typeof e.dataType === "string" ? e.dataType : undefined,
    routine: typeof e.routine === "string" ? e.routine : undefined,
  };
}

// ── Snapshot Normalizer ────────────────────────────────────────

/**
 * Normalize a single snapshot's values before DB insert.
 * Converts numbers to numeric strings, validates UUIDs.
 */
export function normalizeSnapshot(snap: {
  quotaPoolId: string;
  usageAmount: number;
  confidence: number;
}): { usageAmount: string; confidence: string; quotaPoolId: string } | string {
  // Validate UUID
  if (!isValidUUID(snap.quotaPoolId)) {
    return `Invalid quotaPoolId UUID: ${snap.quotaPoolId}`;
  }

  // Convert numerics
  const usageStr = toNumericString(snap.usageAmount);
  if (usageStr === null) {
    return `Invalid usageAmount: ${snap.usageAmount}`;
  }

  const confStr = toNumericString(snap.confidence);
  if (confStr === null) {
    return `Invalid confidence: ${snap.confidence}`;
  }

  return { quotaPoolId: snap.quotaPoolId, usageAmount: usageStr, confidence: confStr };
}
