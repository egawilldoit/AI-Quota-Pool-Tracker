/**
 * Hermes collector — reads Hermes provider/model metadata from
 * ~/.hermes/config.yaml to classify which quota pool Hermes belongs to.
 *
 * PRIVACY SAFEGUARDS:
 *   - Reads ONLY ~/.hermes/config.yaml (provider and model settings)
 *   - NEVER reads ~/.hermes/.env (contains API keys), auth files,
 *     memory files, session files, prompts, completions, or any
 *     other sensitive user data.
 *   - All output is passed through sanitize() before returning.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { QuotaPoolSnapshot, ToolInfo } from "../payload";
import { sanitize } from "../sanitizer";

export interface HermesCollectorResult {
  snapshots: QuotaPoolSnapshot[];
  toolInfos: ToolInfo[];
  rawMetadata?: Record<string, unknown>;
}

// ── Pool Mappings ──────────────────────────────────────────────────

interface PoolMapping {
  quotaPoolId: string;
  poolName: string;
  confidence: number;
}

const POOL_OPENCODE_GO: PoolMapping = {
  quotaPoolId: "00000000-0000-0000-0000-000000000002",
  poolName: "OpenCode Go",
  confidence: 0.8,
};

const POOL_OPENAI: PoolMapping = {
  quotaPoolId: "00000000-0000-0000-0000-000000000003",
  poolName: "OpenAI Provider",
  confidence: 0.7,
};

const POOL_FREE: PoolMapping = {
  quotaPoolId: "00000000-0000-0000-0000-000000000004",
  poolName: "Free",
  confidence: 0.5,
};

const POOL_UNKNOWN: PoolMapping = {
  quotaPoolId: "00000000-0000-0000-0000-000000000004",
  poolName: "Unknown",
  confidence: 0.3,
};

// ── Config Parsing (regex only, no YAML parser) ────────────────────

interface HermesConfigData {
  provider: string;
  model: string;
}

/**
 * Extract the active model provider and model name from
 * ~/.hermes/config.yaml using simple regex patterns.
 *
 * We check these sections in order:
 *   1. delegation: { model, provider }  — used for subagent/session model
 *   2. model: { default, provider }     — top-level default model config
 *
 * Returns null if config is missing or unparseable.
 */
function extractActiveModel(configText: string): { provider: string; model: string } | null {
  // Try delegation section first (used for the current session model)
  // Matches: delegation:\n  model: deepseek-v4-flash\n  provider: opencode-go
  const delegationModelMatch = configText.match(
    /^delegation:\s*\n\s+model:\s*['\"]?([^\s'\"\n]+)['\"]?\s*\n\s+provider:\s*['\"]?([^\s'\"\n]+)/m,
  );
  if (delegationModelMatch) {
    return {
      model: delegationModelMatch[1],
      provider: delegationModelMatch[2],
    };
  }

  // Fall back to top-level model.default
  // Matches: model:\n  default: some-model\n  provider: some-provider
  const defaultModelMatch = configText.match(
    /^model:\s*\n\s+default:\s*['\"]?([^\s'\"\n]+)['\"]?\s*\n\s+provider:\s*['\"]?([^\s'\"\n]+)/m,
  );
  if (defaultModelMatch) {
    return {
      model: defaultModelMatch[1],
      provider: defaultModelMatch[2],
    };
  }

  // Try just model.default without provider
  const modelOnlyMatch = configText.match(/^model:\s*\n\s+default:\s*['\"]?([^\s'\"\n]+)/m);
  if (modelOnlyMatch) {
    return {
      model: modelOnlyMatch[1],
      provider: "unknown",
    };
  }

  return null;
}

/**
 * Classify the Hermes quota pool based on provider and model name.
 *
 * Mapping rules:
 *   - provider starts with "opencode-go" → OpenCode Go pool (conf 0.8)
 *   - provider is "openai" or "openrouter" with model having "openai" prefix → OpenAI Provider (conf 0.7)
 *   - provider is "openai" → OpenAI Provider (conf 0.7)
 *   - model has ":free" suffix → Free pool (conf 0.5)
 *   - otherwise → Unknown pool (conf 0.3)
 */
function classifyPool(provider: string, model: string): PoolMapping {
  const normProvider = provider.trim().toLowerCase();
  const normModel = model.trim().toLowerCase();

  // OpenCode Go provider
  if (normProvider === "opencode-go") {
    return POOL_OPENCODE_GO;
  }

  // OpenAI provider
  if (normProvider === "openai") {
    return POOL_OPENAI;
  }

  // OpenRouter with an OpenAI model
  if (normProvider === "openrouter" && normModel.startsWith("openai/")) {
    return POOL_OPENAI;
  }

  // Free model suffix (:free from OpenRouter)
  if (normModel.endsWith(":free")) {
    return POOL_FREE;
  }

  // Unknown / fallback
  return POOL_UNKNOWN;
}

/**
 * Derive a stable device fingerprint for Hermes.
 */
function deriveFingerprint(): string {
  const raw = `${os.hostname()}:${os.platform()}:hermes`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

/**
 * Read Hermes config.yaml safely. Returns null on any failure
 * (including Hermes not being installed).
 */
function readHermesConfig(): HermesConfigData | null {
  const homeDir = os.homedir();
  const configPath = path.join(homeDir, ".hermes", "config.yaml");

  try {
    if (!fs.existsSync(configPath)) {
      return null;
    }

    const raw = fs.readFileSync(configPath, "utf-8");
    const active = extractActiveModel(raw);

    if (!active) {
      return null;
    }

    return active;
  } catch {
    return null;
  }
}

// ── Main Collector ─────────────────────────────────────────────────

export async function collectHermes(): Promise<HermesCollectorResult> {
  const now = new Date();
  const windowStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const windowEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

  const config = readHermesConfig();

  if (!config) {
    // Hermes not installed or config not readable — return empty data
    const result: HermesCollectorResult = {
      snapshots: [],
      toolInfos: [
        {
          toolType: "hermes",
          displayName: "Hermes Agent",
          agentFingerprint: `hermes-${deriveFingerprint()}`,
          metadata: JSON.stringify({ detected: false }),
        },
      ],
      rawMetadata: { error: "Hermes config not found or unreadable" },
    };
    return sanitize(result) as HermesCollectorResult;
  }

  const pool = classifyPool(config.provider, config.model);
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const snapshots: QuotaPoolSnapshot[] = [
    {
      quotaPoolId: pool.quotaPoolId,
      windowName: `${monthKey}-monthly`,
      usageAmount: 0,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      idempotencyKey: `hermes-${pool.poolName.toLowerCase().replace(/\s+/g, "-")}-${monthKey}`,
      source: "heartbeat",
      confidence: pool.confidence,
    },
  ];

  const toolInfos: ToolInfo[] = [
    {
      toolType: "hermes",
      displayName: `Hermes Agent (${pool.poolName})`,
      agentFingerprint: `hermes-${pool.poolName.toLowerCase().replace(/\s+/g, "-")}-${deriveFingerprint()}`,
      metadata: JSON.stringify({
        detected: true,
        provider: config.provider,
        model: config.model,
        pool: pool.poolName,
      }),
    },
  ];

  const rawMetadata: Record<string, unknown> = {
    provider: config.provider,
    model: config.model,
    classifiedPool: pool.poolName,
  };

  const result: HermesCollectorResult = {
    snapshots,
    toolInfos,
    rawMetadata,
  };

  return sanitize(result) as HermesCollectorResult;
}
