/**
 * Sanitizer — redacts token-like and secret-like values from agent output.
 *
 * Patterns matched (case-insensitive unless noted):
 *   - sk-*              (OpenAI-style secret keys)
 *   - tok_*             (Stripe-style tokens)
 *   - lin_api_*         (Line API tokens)
 *   *-key, *-secret, *-token   (any context where "key", "secret", or "token"
 *                                appears as a word or suffix)
 *
 * The sanitizer recursively walks any JSON-serializable value and returns
 * a deep copy with all sensitive values replaced by "[REDACTED]".
 */

// ── Regex Patterns ────────────────────────────────────────────

/** Values that, when matched entirely, are secret. */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /^sk-\S+/i,            // OpenAI / 3rd-party secret keys
  /^tok_\S+/i,           // Stripe-like tokens
  /^lin_api_\S+/i,       // Line messaging API tokens
  /^ghp_\S+/i,           // GitHub personal access tokens
  /^gho_\S+/i,           // GitHub OAuth tokens
  /^ghu_\S+/i,           // GitHub user tokens
  /^xox[bpar]-/,         // Slack tokens
  /^AKIA[A-Z0-9]{16}/,   // AWS access key IDs
];

/** Property names whose VALUE should be redacted regardless of shape.
 *
 *  NOTE: We explicitly exclude known safe fields like `idempotencyKey`
 *  from redaction. Only real secret/credential property names are caught. */
const SECRET_PROPERTY_NAMES: RegExp[] = [
  /^api[-_]?key$/i,       // "apiKey", "api_key"
  /^api[-_]?secret$/i,    // "apiSecret", "api_secret"
  /^secret[-_]?key$/i,    // "secretKey"
  /^private[-_]?key$/i,   // "privateKey"
  /^access[-_]?key$/i,    // "accessKey", "access_key"
  /^access[-_]?secret$/i, // "accessSecret"
  /^token$/i,              // bare "token" property
  /^password$/i,
  /^bearer$/i,
  /^auth$/i,
  /^authorization$/i,
];

/** Property names whose entire VALUE string should be redacted when the
 *  property name itself is not a secret name but the value looks like one. */
const SUSPICIOUS_VALUE_PATTERNS: RegExp[] = [
  /^sk-\S+/i,
  /^tok_\S+/i,
  /^lin_api_\S+/i,
  /^gh[pou]_/,
  /^xox[bpar]-/,
  /^AKIA[A-Z0-9]{16}/,
];

// ── Helpers ───────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function matchesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(value));
}

function propertyNameIsSecret(name: string): boolean {
  return matchesAny(name, SECRET_PROPERTY_NAMES);
}

function valueLooksSecret(value: string): boolean {
  return matchesAny(value, SUSPICIOUS_VALUE_PATTERNS) || matchesAny(value, SECRET_VALUE_PATTERNS);
}

// ── Sanitizer ────────────────────────────────────────────────

/**
 * Recursively redact secrets from an arbitrary value, returning a deep copy.
 */
export function sanitize<T>(value: T): T {
  if (typeof value === "string") {
    // Check if this string value itself looks like a secret
    if (valueLooksSecret(value)) {
      return "[REDACTED]" as unknown as T;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item)) as unknown as T;
  }

  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (propertyNameIsSecret(key)) {
        // Redact the entire value regardless of type
        out[key] = sanitizePrimitive(val);
      } else if (isString(val) && valueLooksSecret(val)) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = sanitize(val);
      }
    }
    return out as T;
  }

  // Primitives (number, boolean, null, undefined) — pass through
  return value;
}

function sanitizePrimitive(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  return "[REDACTED]";
}

/**
 * Convenience: sanitize a JSON string in memory and return parsed object.
 * Useful when you have a raw JSON string from a config file or collector.
 */
export function sanitizeJsonString(raw: string): unknown {
  try {
    const parsed = JSON.parse(raw);
    return sanitize(parsed);
  } catch {
    // If it's not valid JSON, return a redacted version
    return "[INVALID JSON — REDACTED]";
  }
}

/**
 * Quick check if a string looks like a secret token.
 */
export function isSecretValue(value: string): boolean {
  return valueLooksSecret(value);
}
