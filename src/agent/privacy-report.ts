/**
 * Privacy Report — explicitly documents what the agent uploads
 * and what it NEVER uploads.
 *
 * This helps users understand the data boundary of the tool:
 * nothing sensitive leaves the machine except the normalized
 * ingest fields defined in the EGA-399 contract.
 */

// ── Fields That ARE Uploaded ──────────────────────────────────

export const UPLOADED_FIELDS = [
  // Device info (non-identifying, no tokens)
  { field: "device.deviceFingerprint", description: "Stable device identifier (hostname + OS hash)" },
  { field: "device.agentVersion", description: "Agent software version string" },
  { field: "device.os", description: "Operating system platform string" },

  // Quota pool snapshots
  { field: "quotaPoolSnapshots[].quotaPoolId", description: "UUID of the quota pool on the server" },
  { field: "quotaPoolSnapshots[].windowName", description: "Usage window label (e.g. 2026-06-monthly)" },
  { field: "quotaPoolSnapshots[].usageAmount", description: "Numeric usage amount" },
  { field: "quotaPoolSnapshots[].windowStart", description: "ISO-8601 start of usage window" },
  { field: "quotaPoolSnapshots[].windowEnd", description: "ISO-8601 end of usage window" },
  { field: "quotaPoolSnapshots[].idempotencyKey", description: "Deduplication key" },
  { field: "quotaPoolSnapshots[].source", description: "Source label (heartbeat, manual, import)" },
  { field: "quotaPoolSnapshots[].confidence", description: "Confidence score 0-1" },

  // Tool quota attributions
  { field: "toolQuotaAttributions[].toolInstanceFingerprint", description: "Tool fingerprint (matches agentFingerprint)" },
  { field: "toolQuotaAttributions[].quotaPoolId", description: "UUID of the quota pool" },
  { field: "toolQuotaAttributions[].allocatedAmount", description: "Numeric allocated quota amount" },

  // Tool info
  { field: "toolInfos[].toolType", description: "AI tool type string (codex, opencode, hermes, ...)" },
  { field: "toolInfos[].displayName", description: "Human-readable display name" },
  { field: "toolInfos[].agentFingerprint", description: "Stable tool instance identifier" },
  { field: "toolInfos[].metadata", description: "JSON blob (version, mode, model — never raw secrets)" },

  // Codex-specific fields (from ~/.codex/config.toml — model name only)
  { field: "codex model name", description: "Model name from config.toml (e.g. gpt-5.5) — used to classify paid vs free pool" },
  { field: "codex tool type", description: "Tool type identifier 'codex' for the Codex CLI" },
  { field: "codex detection status", description: "Whether Codex CLI and config.toml were detected on the machine" },

  // OpenCode-specific fields (from opencode models output — model names only)
  { field: "opencode models list", description: "Model names from `opencode models` — used to detect provider prefixes (opencode-go/, openai/, opencode/)" },
  { field: "opencode detected providers", description: "Unique provider prefixes parsed from model names (e.g. opencode-go, openai, google, openrouter)" },
  { field: "opencode classified pool", description: "Quota pool assignment based on detected providers (OpenCode Go, OpenAI Provider, Free, Unknown)" },
  { field: "opencode models count", description: "Total number of available models (numeric only)" },

  // Hermes-specific fields (from ~/.hermes/config.yaml — provider and model only)
  { field: "hermes provider", description: "Provider name from config.yaml delegation section (e.g. opencode-go, openrouter, openai)" },
  { field: "hermes model", description: "Model name from config.yaml delegation section (e.g. deepseek-v4-flash, gpt-4o)" },
  { field: "hermes classified pool", description: "Quota pool assignment based on provider/model mapping (OpenCode Go, OpenAI Provider, Free, Unknown)" },
  { field: "hermes detection status", description: "Whether Hermes config.yaml was detected on the machine" },
];

// ── Fields That Are NEVER Uploaded ────────────────────────────

export const NEVER_UPLOADED_FIELDS = [
  { field: "API keys / tokens", description: "All raw API keys (sk-*, tok_*, lin_api_*, etc.) are redacted or never collected" },
  { field: "Prompts / completions", description: "Agent does not collect any prompt or completion text" },
  { field: "Source code", description: "No source code files are read or uploaded" },
  { field: "Cookies", description: "Browser cookies are never accessed" },
  { field: "Auth files", description: "~/.ssh/*, ~/.config/* credentials, .env files not collected" },
  { field: "Shell history", description: "~/.bash_history, ~/.zsh_history never read" },
  { field: "Personal data", description: "No names, emails, addresses, or PII collected" },
  { field: "Private keys", description: "No SSH keys, GPG keys, or certificate private keys" },
  { field: "Raw config files", description: "Config files may be examined for usage counts only; raw values redacted" },
  { field: "Device exact hostname", description: "Fingerprints are hashed/derived, not raw hostnames" },
  { field: "Network info", description: "No IP addresses, MAC addresses, or network topology" },
];

// ── Report Generator ─────────────────────────────────────────

export interface PrivacyReport {
  summary: string;
  uploadedFields: typeof UPLOADED_FIELDS;
  neverUploadedFields: typeof NEVER_UPLOADED_FIELDS;
  timestamp: string;
}

/**
 * Generate a complete privacy report.
 */
export function generatePrivacyReport(): PrivacyReport {
  return {
    summary:
      "The AI Quota Pool Tracker agent collects only normalized, non-sensitive " +
      "quota usage data. No prompts, completions, source code, keys, tokens, " +
      "cookies, or personal data are ever uploaded. All collected fields are " +
      "clearly listed below.",
    uploadedFields: UPLOADED_FIELDS,
    neverUploadedFields: NEVER_UPLOADED_FIELDS,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Print privacy report to console (stdout).
 */
export function printPrivacyReport(): void {
  const report = generatePrivacyReport();

  console.log("=".repeat(72));
  console.log("  AI Quota Pool Tracker — Privacy Report");
  console.log("=".repeat(72));
  console.log("");
  console.log(report.summary);
  console.log("");
  console.log("Generated: ", report.timestamp);
  console.log("");

  console.log("─".repeat(72));
  console.log("  Fields Uploaded to Server:");
  console.log("─".repeat(72));
  for (const f of report.uploadedFields) {
    console.log(`  ✔  ${f.field}`);
    console.log(`     ${f.description}`);
  }

  console.log("");
  console.log("─".repeat(72));
  console.log("  Fields NEVER Uploaded:");
  console.log("─".repeat(72));
  for (const f of report.neverUploadedFields) {
    console.log(`  ✘  ${f.field}`);
    console.log(`     ${f.description}`);
  }

  console.log("");
  console.log("─".repeat(72));
  console.log("  Data Boundary Summary");
  console.log("─".repeat(72));
  console.log("");
  console.log("  Uploaded:     only quota usage metrics + device fingerprint");
  console.log("  Never:        tokens, keys, prompts, completions, code,");
  console.log("                cookies, auth files, shell history, PII");
  console.log("");
  console.log("  In dry-run mode, the generated payload is printed to stdout");
  console.log("  but NEVER sent to any server.");
  console.log("=".repeat(72));
}
