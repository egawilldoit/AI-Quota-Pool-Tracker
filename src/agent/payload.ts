/**
 * Payload shape matching the EGA-399 POST /api/ingest contract.
 *
 * This is the normalized format that the agent collects and sends
 * (or prints in dry-run mode). No secrets, tokens, prompts,
 * completions, source code, cookies, or auth files appear here.
 */

// ── Primitives ────────────────────────────────────────────────

export interface DeviceInfo {
  deviceFingerprint: string;
  agentVersion?: string;
  os?: string;
}

export interface QuotaPoolSnapshot {
  quotaPoolId: string;
  windowName: string;
  usageAmount: number;
  windowStart: string; // ISO-8601
  windowEnd: string;   // ISO-8601
  idempotencyKey: string;
  source?: string;     // default: "heartbeat"
  confidence?: number;  // 0-1, default: 1
}

export interface ToolQuotaAttribution {
  /** Matches agentFingerprint from toolInfos */
  toolInstanceFingerprint: string;
  quotaPoolId: string;
  allocatedAmount: number;
}

export interface ToolInfo {
  toolType: string;       // e.g. "codex", "opencode", "hermes"
  displayName?: string;
  agentFingerprint: string;
  metadata?: string;      // JSON blob
}

// ── Ingest Payload ────────────────────────────────────────────

export interface IngestPayload {
  device: DeviceInfo;
  quotaPoolSnapshots: QuotaPoolSnapshot[];
  toolQuotaAttributions: ToolQuotaAttribution[];
  toolInfos: ToolInfo[];
}

/**
 * Factory to create an empty/initialized ingest payload.
 */
export function createEmptyPayload(device?: Partial<DeviceInfo>): IngestPayload {
  return {
    device: {
      deviceFingerprint: device?.deviceFingerprint ?? "dry-run-device-001",
      agentVersion: device?.agentVersion ?? "0.1.0",
      os: device?.os ?? process.platform,
    },
    quotaPoolSnapshots: [],
    toolQuotaAttributions: [],
    toolInfos: [],
  };
}
