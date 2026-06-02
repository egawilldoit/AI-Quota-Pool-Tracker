/**
 * Spool queue for failed agent uploads.
 *
 * Failed upload payloads (sanitized) are written to disk at
 * ~/.local/share/ega-devtrack/spool/ and retried before sending new data.
 *
 * Guardrails:
 *  - Max entry age: 7 days (auto-cleaned on read)
 *  - Max entries: 100 (new writes skipped if exceeded)
 *  - Max total size: 50 MB (new writes skipped if exceeded)
 *  - Only sanitized payloads are stored (passed through sanitize())
 */
import { mkdirSync, existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { sanitize } from "./sanitizer";
import type { IngestPayload } from "./payload";

// ── Types ──────────────────────────────────────────────────────────────

export interface SpoolEntry {
  /** Unique entry identifier (timestamp + random suffix) */
  id: string;
  /** ISO-8601 creation timestamp */
  createdAt: string;
  /** Number of retry attempts so far */
  retryCount: number;
  /** ISO-8601 timestamp of the last retry attempt */
  lastRetryAt: string | null;
  /** The sanitized ingest payload */
  payload: IngestPayload;
}

export interface SpoolHealth {
  /** Number of entries currently in the spool */
  entryCount: number;
  /** Age of the oldest entry in milliseconds (0 if empty) */
  oldestAgeMs: number;
  /** Total size of all spool files in bytes */
  totalSizeBytes: number;
  /** Whether the spool is healthy (under size/count limits) */
  healthy: boolean;
  /** ISO-8601 timestamp of the oldest entry, or null if empty */
  oldestEntryAt: string | null;
}

// ── Constants ──────────────────────────────────────────────────────────

const SPOOL_DIR = join(homedir(), ".local", "share", "ega-devtrack", "spool");
const MAX_ENTRY_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_ENTRIES = 100;
const MAX_TOTAL_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_RETRY_COUNT = 3; // Max retries before permanent rejection

// ── Internal helpers ───────────────────────────────────────────────────

function ensureSpoolDir(): void {
  if (!existsSync(SPOOL_DIR)) {
    mkdirSync(SPOOL_DIR, { recursive: true });
  }
}

function spoolFilePath(entryId: string): string {
  return join(SPOOL_DIR, `${entryId}.json`);
}

/**
 * Load a single spool file and parse it. Returns null on any parse error.
 */
function loadSpoolFile(filename: string): SpoolEntry | null {
  const fp = join(SPOOL_DIR, filename);
  try {
    const raw = readFileSync(fp, "utf-8");
    const parsed = JSON.parse(raw);
    // Basic shape validation
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.retryCount !== "number" ||
      typeof parsed.payload !== "object" ||
      parsed.payload === null
    ) {
      return null;
    }
    return parsed as SpoolEntry;
  } catch {
    return null;
  }
}

/**
 * Clean old entries (older than 7 days). Runs inside readSpool().
 */
function cleanOldEntries(): void {
  if (!existsSync(SPOOL_DIR)) return;
  const now = Date.now();
  for (const filename of readdirSync(SPOOL_DIR)) {
    if (!filename.endsWith(".json")) continue;
    const entry = loadSpoolFile(filename);
    if (!entry) {
      // Corrupted file — remove it
      try {
        unlinkSync(join(SPOOL_DIR, filename));
      } catch {
        // best-effort
      }
      continue;
    }
    const age = now - new Date(entry.createdAt).getTime();
    if (age > MAX_ENTRY_AGE_MS) {
      try {
        unlinkSync(join(SPOOL_DIR, filename));
      } catch {
        // best-effort
      }
    }
  }
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Write a sanitized payload to the spool.
 *
 * The payload is run through sanitize() before storage.
 * If the spool is full (over 100 entries or 50 MB total), the write is
 * skipped and a warning is logged to stderr.
 *
 * @returns The entry ID if written, or null if skipped due to limits.
 */
export function writeSpool(payload: IngestPayload): string | null {
  ensureSpoolDir();

  // Clean old entries first
  cleanOldEntries();

  // Check entry count limit
  let currentFiles: string[];
  try {
    currentFiles = readdirSync(SPOOL_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    currentFiles = [];
  }

  if (currentFiles.length >= MAX_ENTRIES) {
    console.warn(`[spool] WARNING: spool has ${currentFiles.length} entries (max ${MAX_ENTRIES}). Skipping write.`);
    return null;
  }

  // Check total size limit
  let totalSize = 0;
  for (const f of currentFiles) {
    try {
      totalSize += statSync(join(SPOOL_DIR, f)).size;
    } catch {
      // best-effort
    }
  }
  if (totalSize >= MAX_TOTAL_SIZE_BYTES) {
    console.warn(
      `[spool] WARNING: spool total size is ${(totalSize / 1024 / 1024).toFixed(1)} MB (max ${MAX_TOTAL_SIZE_BYTES / 1024 / 1024} MB). Skipping write.`,
    );
    return null;
  }

  // Sanitize the payload before storing
  const sanitizedPayload = sanitize(payload) as IngestPayload;

  const now = new Date();
  const id = `${now.getTime()}-${Math.random().toString(36).substring(2, 10)}`;
  const entry: SpoolEntry = {
    id,
    createdAt: now.toISOString(),
    retryCount: 0,
    lastRetryAt: null,
    payload: sanitizedPayload,
  };

  const fp = spoolFilePath(id);
  writeFileSync(fp, JSON.stringify(entry, null, 2), "utf-8");
  return id;
}

/**
 * Read all unprocessed spool entries, sorted oldest-first.
 *
 * Also cleans entries older than 7 days, removes corrupted files,
 * and moves entries with too many retries to the rejected directory.
 *
 * @returns Array of spool entries (never null/undefined).
 */
export function readSpool(): SpoolEntry[] {
  if (!existsSync(SPOOL_DIR)) return [];

  // Clean old entries first
  cleanOldEntries();

  const entries: SpoolEntry[] = [];
  for (const filename of readdirSync(SPOOL_DIR)) {
    if (!filename.endsWith(".json")) continue;
    const entry = loadSpoolFile(filename);
    if (!entry) {
      // Corrupted file — remove it
      try {
        unlinkSync(join(SPOOL_DIR, filename));
      } catch {
        // best-effort
      }
      continue;
    }

    // Entries with too many retries → reject permanently
    if (entry.retryCount >= MAX_RETRY_COUNT) {
      try {
        unlinkSync(join(SPOOL_DIR, filename));
        console.warn(`[spool] Entry ${entry.id} rejected after ${entry.retryCount} retries.`);
      } catch {
        // best-effort
      }
      continue;
    }

    entries.push(entry);
  }

  // Sort oldest first
  entries.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  return entries;
}

/**
 * Delete a spool entry by ID.
 */
export function deleteSpoolEntry(id: string): void {
  const fp = spoolFilePath(id);
  try {
    unlinkSync(fp);
  } catch {
    // File may already be gone — best-effort
  }
}

/**
 * Get spool health information: count, oldest age, total size.
 */
export function getSpoolHealth(): SpoolHealth {
  if (!existsSync(SPOOL_DIR)) {
    return {
      entryCount: 0,
      oldestAgeMs: 0,
      totalSizeBytes: 0,
      healthy: true,
      oldestEntryAt: null,
    };
  }

  const files = readdirSync(SPOOL_DIR).filter((f) => f.endsWith(".json"));
  const now = Date.now();
  let totalSize = 0;
  let oldestAgeMs = 0;
  let oldestEntryAt: string | null = null;

  for (const filename of files) {
    const fp = join(SPOOL_DIR, filename);
    try {
      totalSize += statSync(fp).size;
    } catch {
      // best-effort
    }
    const entry = loadSpoolFile(filename);
    if (entry) {
      const age = now - new Date(entry.createdAt).getTime();
      if (age > oldestAgeMs) {
        oldestAgeMs = age;
        oldestEntryAt = entry.createdAt;
      }
    }
  }

  const entryCount = files.length;

  return {
    entryCount,
    oldestAgeMs,
    totalSizeBytes: totalSize,
    healthy: entryCount < MAX_ENTRIES && totalSize < MAX_TOTAL_SIZE_BYTES,
    oldestEntryAt,
  };
}
