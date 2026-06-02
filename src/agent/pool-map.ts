/**
 * Pool ID mapper — maps known pool kinds/names to real server-side UUIDs.
 *
 * After device registration, the CLI saves the workspace config which
 * includes the real quota pool UUIDs from the server. This module
 * reads that mapping so collectors use real UUIDs instead of mock ones.
 *
 * PRIVACY: Only pool kind/displayName mappings — no secrets.
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface PoolMapping {
  quotaPoolId: string;
  kind: string;
  displayName: string;
}

const CONFIG_DIR = join(homedir(), ".local", "share", "ega-devtrack");
const POOL_MAP_FILE = join(CONFIG_DIR, "pool-map.json");

// Fallback pool IDs used when config is not yet populated (dry-run without register)
export const FALLBACK_POOLS: PoolMapping[] = [
  { quotaPoolId: "00000000-0000-0000-0000-000000000001", kind: "credits", displayName: "Codex & ChatGPT" },
  { quotaPoolId: "00000000-0000-0000-0000-000000000002", kind: "tokens", displayName: "OpenCode Go" },
  { quotaPoolId: "00000000-0000-0000-0000-000000000003", kind: "api_calls", displayName: "OpenAI Provider" },
  { quotaPoolId: "00000000-0000-0000-0000-000000000004", kind: "free", displayName: "Free / Unknown" },
];

/**
 * Load pool mappings from local config, or fall back to hardcoded defaults.
 */
export function loadPoolMappings(): PoolMapping[] {
  try {
    if (existsSync(POOL_MAP_FILE)) {
      const raw = readFileSync(POOL_MAP_FILE, "utf-8");
      const parsed = JSON.parse(raw) as PoolMapping[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    }
  } catch {
    // Ignore corrupt file, fall back
  }
  return FALLBACK_POOLS;
}

/**
 * Save pool mappings to local config (called after registration).
 */
export function savePoolMappings(mappings: PoolMapping[]): void {
  try {
    const dir = CONFIG_DIR;
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(POOL_MAP_FILE, JSON.stringify(mappings, null, 2), "utf-8");
  } catch {
    // Non-critical — fallback pool IDs will be used
  }
}

/**
 * Find a pool by its kind string.
 */
export function getPoolByKind(kind: string): PoolMapping | undefined {
  const pools = loadPoolMappings();
  return pools.find((p) => p.kind === kind);
}

/**
 * Find a pool by a substring match on displayName (case-insensitive).
 */
export function getPoolByName(name: string): PoolMapping | undefined {
  const pools = loadPoolMappings();
  const lower = name.toLowerCase();
  return pools.find((p) => p.displayName.toLowerCase().includes(lower));
}

/**
 * Resolve a pool ID for a known pool kind, falling back to the first pool
 * if the kind is unknown.
 */
export function resolvePoolId(kind: string): string {
  const pool = getPoolByKind(kind);
  if (pool) return pool.quotaPoolId;
  // Fallback: use the first pool
  const pools = loadPoolMappings();
  if (pools.length > 0) return pools[0].quotaPoolId;
  return "00000000-0000-0000-0000-000000000001";
}
