#!/usr/bin/env node

/**
 * ega-devtrack — AI Quota Pool Tracker agent CLI.
 *
 * Commands:
 *   register --token TOKEN   Register this device and save device token locally
 *   once --dry-run           Run collectors and print normalized payload (no upload)
 *   once --upload            Run collectors and upload payload to server
 *   privacy-report           Print what's uploaded vs never uploaded
 *   install                  Install systemd timer to run agent every 15 minutes
 *   uninstall                Remove the systemd timer and service
 *   status                   Show scheduler status (last/next run, timer state, spool health)
 *   --help                   Show this help
 *
 * Upload flow:
 *   1. On `once --upload`, the agent first reads the spool and retries any
 *      previously failed uploads (oldest first).
 *   2. Then it collects fresh data and attempts to upload.
 *   3. If the upload fails, the payload is written to the local spool
 *      (~/.local/share/ega-devtrack/spool/) for later retry.
 *   4. Dry-run mode never writes to the spool.
 *
 *   The API endpoint is configured via the DEVTRAK_API_URL environment variable.
 *   Default: http://localhost:3000
 *
 * All output is sanitized — no raw tokens/secrets appear.
 */

import { runAllCollectors } from "../src/agent/collectors/index";
import { printPrivacyReport } from "../src/agent/privacy-report";
import { savePoolMappings, loadPoolMappings } from "../src/agent/pool-map";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import crypto from "node:crypto";
import { writeSpool, readSpool, deleteSpoolEntry, getSpoolHealth } from "../src/agent/spool";

const args = process.argv.slice(2);

function showHelp(): void {
  console.log(`
  ega-devtrack — AI Quota Pool Tracker Agent

  USAGE:
    ega-devtrack register --token TOKEN  Register this device with server
    ega-devtrack once --dry-run         Collect & print normalized payload (no upload)
    ega-devtrack once --upload          Collect, upload to server, retry spooled items
    ega-devtrack privacy-report         Print privacy report
    ega-devtrack install                Install systemd timer (runs every 15 min)
    ega-devtrack uninstall              Remove installed systemd timer & service
    ega-devtrack status                 Show scheduler status
    ega-devtrack verify                 Verify data pipeline freshness
    ega-devtrack opencode-go manual     Upload manual OpenCode Go usage percentages
    ega-devtrack codex manual           Upload manual Codex usage windows
    ega-devtrack cleanup stale-windows  Dry-run/apply current-state stale cleanup
    ega-devtrack --help                 Show this help

  OPTIONS:
    --dry-run   Run collectors and output normalized payload to stdout.
                Everything is sanitized. NO data is uploaded.
                Exits 0 even if collectors fail.

    --upload    Run collectors and upload the collected payload to the
                configured API endpoint (DEVTRAK_API_URL, default
                http://localhost:3000).
                BEFORE collecting fresh data, any spooled items (failed
                uploads from previous runs) are retried first.
                Spool location: ~/.local/share/ega-devtrack/spool/

  ENVIRONMENT:
    DEVTRAK_API_URL   API endpoint for upload (default: http://localhost:3000)
    DEVTRAK_DEVICE_TOKEN  Optional device token override for upload auth

  SCHEDULER (install / uninstall / status):
    Linux: Creates systemd user service + timer units at
           ~/.config/systemd/user/ega-devtrack.{service,timer}
           and enables them with \`systemctl --user\`.
           The timer triggers \`ega-devtrack once\` every 15 minutes.

           Scheduled runs upload with saved registration token.

    Windows: Not yet supported (cross-platform support planned).

  PRIVACY:
    The agent NEVER uploads: tokens, keys, secrets, prompts,
    completions, source code, cookies, auth files, shell history,
    or any PII. See \`ega-devtrack privacy-report\` for details.

  EXAMPLES:
    ega-devtrack once --dry-run
    ega-devtrack register --token <bootstrap-token>
    ega-devtrack once --upload
    ega-devtrack privacy-report
    ega-devtrack install
    ega-devtrack status
    ega-devtrack uninstall
`.trim());
}

/**
 * Resolve the absolute path to ega-devtrack.js.
 * We use the JS wrapper so systemd invokes tsx via the node script.
 */
function resolveCliJsPath(): string {
  return resolve(__dirname, "ega-devtrack.js");
}

/**
 * Return the path to the project root (parent of scripts/).
 */
function resolveProjectRoot(): string {
  return resolve(__dirname, "..");
}

// ── Scheduler (systemd) helpers ──────────────────────────────────────

function getUserConfigDir(): string {
  return join(homedir(), ".config", "systemd", "user");
}

function getDataDir(): string {
  return join(homedir(), ".local", "share", "ega-devtrack");
}

type AgentConfig = {
  apiBaseUrl?: string;
  deviceToken?: string;
  deviceFingerprint?: string;
  deviceName?: string;
};

function configPath(): string {
  return join(getDataDir(), "config.json");
}

function ensureDataDir(): void {
  if (!existsSync(getDataDir())) {
    mkdirSync(getDataDir(), { recursive: true });
  }
}

function readAgentConfig(): AgentConfig {
  try {
    if (!existsSync(configPath())) return {};
    return JSON.parse(readFileSync(configPath(), "utf-8")) as AgentConfig;
  } catch {
    return {};
  }
}

function writeAgentConfig(config: AgentConfig): void {
  ensureDataDir();
  writeFileSync(configPath(), JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o600 });
}

function argValue(name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function getApiBaseUrl(config = readAgentConfig()): string {
  return (
    argValue("--endpoint") ??
    process.env.DEVTRAK_API_URL ??
    config.apiBaseUrl ??
    "http://localhost:3000"
  ).replace(/\/+$/, "");
}

function deriveDeviceFingerprint(deviceName: string, osValue: string): string {
  return crypto
    .createHash("sha256")
    .update(`${deviceName}:${osValue}:ega-devtrack`)
    .digest("hex")
    .slice(0, 32);
}

function getDeviceName(): string {
  return argValue("--device-name") ?? process.env.DEVTRAK_DEVICE_NAME ?? `${process.platform}-${crypto.createHash("sha256").update(homedir()).digest("hex").slice(0, 8)}`;
}

function getDeviceToken(config = readAgentConfig()): string | null {
  return process.env.DEVTRAK_DEVICE_TOKEN ?? config.deviceToken ?? null;
}

function authHeaders(token: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

async function cmdRegister(): Promise<void> {
  const bootstrapToken = argValue("--token") ?? process.env.DEVTRAK_BOOTSTRAP_TOKEN;
  if (!bootstrapToken) {
    console.error("ERROR: register requires --token or DEVTRAK_BOOTSTRAP_TOKEN.");
    process.exit(1);
  }

  const config = readAgentConfig();
  const apiBaseUrl = getApiBaseUrl(config);
  const deviceName = getDeviceName();
  const osValue = process.platform;
  const response = await fetch(`${apiBaseUrl}/api/devices/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bootstrapToken,
      deviceName,
      os: osValue,
      agentVersion: "0.1.0",
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "unknown");
    console.error(`ERROR: registration failed (HTTP ${response.status}): ${text}`);
    process.exit(1);
  }

  const body = (await response.json()) as {
    device?: { deviceFingerprint?: string; label?: string };
    deviceToken?: string;
  };

  if (!body.deviceToken) {
    console.error("ERROR: registration response missing device token.");
    process.exit(1);
  }

  writeAgentConfig({
    ...config,
    apiBaseUrl,
    deviceToken: body.deviceToken,
    deviceFingerprint:
      body.device?.deviceFingerprint ?? deriveDeviceFingerprint(deviceName, osValue),
    deviceName: body.device?.label ?? deviceName,
  });

  // ── Fetch and save pool mappings ──────────────────────────────
  try {
    const poolResp = await fetch(`${apiBaseUrl}/api/workspaces`, {
      headers: authHeaders(body.deviceToken),
    });
    if (poolResp.ok) {
      const wsData = (await poolResp.json()) as { workspaces?: { id: string }[] };
      const wsId = wsData.workspaces?.[0]?.id;
      if (wsId) {
        const poolsResp = await fetch(`${apiBaseUrl}/api/workspaces/${wsId}/quota-pools`, {
          headers: authHeaders(body.deviceToken),
        });
        if (poolsResp.ok) {
          const poolsData = (await poolsResp.json()) as { pools?: { id: string; kind: string; displayName: string }[] };
          if (poolsData.pools && poolsData.pools.length > 0) {
            const mappings = poolsData.pools.map((p) => ({
              quotaPoolId: p.id,
              kind: p.kind,
              displayName: p.displayName,
            }));
            savePoolMappings(mappings);
            console.log(`[agent] Saved ${mappings.length} quota pool mappings.`);
          }
        }
      }
    }
  } catch {
    // Non-critical — collectors will use fallback pool IDs
    console.warn("[agent] Warning: could not fetch pool mappings. Collectors will use fallback pool IDs.");
  }

  console.log("[agent] Device registered. Device token saved locally.");
  console.log(`[agent] Config: ${configPath()}`);
}

function serviceUnitPath(): string {
  return join(getUserConfigDir(), "ega-devtrack.service");
}

function timerUnitPath(): string {
  return join(getUserConfigDir(), "ega-devtrack.timer");
}

function generateServiceContent(): string {
  const cliJs = resolveCliJsPath();
  const workDir = resolveProjectRoot();
  return `# ega-devtrack systemd user service
# Installed by \`ega-devtrack install\`
#
# This unit runs a single collector pass.
# It is intended to be triggered by ega-devtrack.timer.

[Unit]
Description=AI Quota Pool Tracker — agent collector run
Documentation=https://github.com/egawilldoit/AI-Quota-Pool-Tracker

[Service]
Type=oneshot
ExecStart=${cliJs} once --upload
WorkingDirectory=${workDir}
StandardOutput=journal
StandardError=journal
`;
}

function generateTimerContent(): string {
  return `# ega-devtrack systemd user timer
# Installed by \`ega-devtrack install\`
#
# Triggers ega-devtrack.service every 15 minutes.

[Unit]
Description=AI Quota Pool Tracker — agent scheduler (every 15 min)
Documentation=https://github.com/egawilldoit/AI-Quota-Pool-Tracker

[Timer]
OnCalendar=*:0/15
Persistent=true

[Install]
WantedBy=timers.target
`;
}

function hasSystemdUser(): boolean {
  try {
    execSync("systemctl --user --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function systemctl(...args: string[]): void {
  execSync(`systemctl --user ${args.join(" ")}`, { stdio: "inherit" });
}

async function cmdInstall(): Promise<void> {
  // ── Guard: systemd available? ──────────────────────────────────
  if (!hasSystemdUser()) {
    console.error(
      "ERROR: systemd user service manager is not available.\n" +
      "  This command requires Linux with systemd (user mode).\n" +
      "  Try:\n" +
      "    - Ensure you are on Linux with systemd\n" +
      "    - Verify \`systemctl --user\` works\n" +
      "    - You may need: loginctl enable-linger $USER",
    );
    process.exit(1);
  }

  // ── Create data directory ──────────────────────────────────────
  const dataDir = getDataDir();
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
    console.log(`Created data directory: ${dataDir}`);
  } else {
    console.log(`Data directory already exists: ${dataDir}`);
  }

  // ── Write unit files (with safety check) ───────────────────────
  const unitDir = getUserConfigDir();
  if (!existsSync(unitDir)) {
    mkdirSync(unitDir, { recursive: true });
  }

  const svcPath = serviceUnitPath();
  const timPath = timerUnitPath();

  // Warn before overwriting existing units
  for (const [label, fp] of [["Service", svcPath], ["Timer", timPath]] as const) {
    if (existsSync(fp)) {
      console.warn(`WARNING: ${label} unit already exists: ${fp}`);
      console.warn("  Overwriting with new configuration.");
    }
  }

  writeFileSync(svcPath, generateServiceContent(), "utf-8");
  console.log(`Wrote service unit: ${svcPath}`);

  writeFileSync(timPath, generateTimerContent(), "utf-8");
  console.log(`Wrote timer unit: ${timPath}`);

  // ── Reload and enable ──────────────────────────────────────────
  console.log("Reloading systemd user daemon...");
  systemctl("daemon-reload");

  console.log("Enabling and starting timer...");
  systemctl("enable", "--now", "ega-devtrack.timer");

  // ── Confirmation and caveat ────────────────────────────────────
  console.log("\n✓ Agent scheduler installed successfully!\n");
  console.log("  Timer:  ega-devtrack.timer");
  console.log("  Service: ega-devtrack.service");
  console.log("  Schedule: every 15 minutes\n");
  console.log("  Scheduled runs upload to DEVTRAK_API_URL or saved endpoint.");
  console.log("  Check status with: ega-devtrack status\n");
}

async function cmdUninstall(): Promise<void> {
  if (!hasSystemdUser()) {
    console.error(
      "ERROR: systemd user service manager is not available.\n" +
      "  Nothing to uninstall.",
    );
    process.exit(1);
  }

  const svcPath = serviceUnitPath();
  const timPath = timerUnitPath();

  const timerExists = existsSync(timPath);
  const serviceExists = existsSync(svcPath);

  if (!timerExists && !serviceExists) {
    console.log("No agent scheduler units found. Nothing to uninstall.");
    process.exit(0);
  }

  // ── Stop and disable timer ─────────────────────────────────────
  if (timerExists) {
    console.log("Stopping and disabling timer...");
    try {
      systemctl("stop", "ega-devtrack.timer");
    } catch {
      console.warn("  (timer may not have been running)");
    }
    try {
      systemctl("disable", "ega-devtrack.timer");
    } catch {
      console.warn("  (timer may not have been enabled)");
    }
  }

  // ── Remove unit files ──────────────────────────────────────────
  if (timerExists) {
    unlinkSync(timPath);
    console.log(`Removed: ${timPath}`);
  }
  if (serviceExists) {
    unlinkSync(svcPath);
    console.log(`Removed: ${svcPath}`);
  }

  // ── Reload daemon ──────────────────────────────────────────────
  console.log("Reloading systemd user daemon...");
  try {
    systemctl("daemon-reload");
  } catch {
    // best-effort
  }

  console.log("\n✓ Agent scheduler uninstalled successfully.");
  console.log("  Data directory (~/.local/share/ega-devtrack/) was left intact.\n");
}

async function cmdStatus(): Promise<void> {
  if (!hasSystemdUser()) {
    console.log("Agent scheduler: NOT AVAILABLE (systemd user mode not found)");
    process.exit(0);
  }

  const timPath = timerUnitPath();
  const svcPath = serviceUnitPath();

  const timerExists = existsSync(timPath);
  const serviceExists = existsSync(svcPath);

  const dataDir = getDataDir();
  const dataExists = existsSync(dataDir);

  console.log("");
  console.log("  ega-devtrack — Agent Scheduler Status");
  console.log("  ─────────────────────────────────────");

  // ── Unit files ─────────────────────────────────────────────────
  console.log(`  Unit files:`);
  console.log(`    Service: ${svcPath}`);
  console.log(`      ${serviceExists ? "EXISTS" : "NOT FOUND"}`);
  console.log(`    Timer:   ${timPath}`);
  console.log(`      ${timerExists ? "EXISTS" : "NOT FOUND"}`);
  console.log(`    Data dir: ${dataDir}`);
  console.log(`      ${dataExists ? "EXISTS" : "NOT FOUND"}`);

  // ── Spool health ───────────────────────────────────────────────
  const spoolHealth = getSpoolHealth();
  console.log(`  Spool:`);
  console.log(`    Entries:     ${spoolHealth.entryCount}`);
  console.log(`    Total size:  ${(spoolHealth.totalSizeBytes / 1024).toFixed(1)} KB`);
  if (spoolHealth.oldestEntryAt) {
    const oldestAgeHours = (spoolHealth.oldestAgeMs / (1000 * 60 * 60)).toFixed(1);
    console.log(`    Oldest age:  ${oldestAgeHours} hours (${spoolHealth.oldestEntryAt})`);
  } else {
    console.log(`    Oldest age:  N/A (empty)`);
  }
  console.log(`    Healthy:     ${spoolHealth.healthy ? "YES" : "NO (over limit)"}`);

  if (!timerExists && !serviceExists) {
    console.log("\n  Status: NOT INSTALLED");
    console.log("  Run `ega-devtrack install` to set up the scheduler.\n");
    process.exit(0);
  }

  // ── systemd state ──────────────────────────────────────────────
  console.log("");

  // Timer state
  try {
    const timerActive = execSync(
      "systemctl --user is-active ega-devtrack.timer",
      { encoding: "utf-8" },
    ).trim();
    console.log(`  Timer active: ${timerActive}`);
  } catch {
    console.log("  Timer active: inactive");
  }

  try {
    const timerEnabled = execSync(
      "systemctl --user is-enabled ega-devtrack.timer",
      { encoding: "utf-8" },
    ).trim();
    console.log(`  Timer enabled: ${timerEnabled}`);
  } catch {
    console.log("  Timer enabled: unknown");
  }

  // Last trigger time
  try {
    const lastTrigger = execSync(
      'systemctl --user show ega-devtrack.timer -p LastTriggerUSec --value',
      { encoding: "utf-8" },
    ).trim();
    if (lastTrigger && lastTrigger !== "0" && lastTrigger !== "") {
      console.log(`  Last triggered: ${lastTrigger}`);
    } else {
      console.log("  Last triggered: never");
    }
  } catch {
    console.log("  Last triggered: unknown");
  }

  // Next trigger time
  try {
    const nextTrigger = execSync(
      'systemctl --user show ega-devtrack.timer -p NextElapseUSecRealtime --value',
      { encoding: "utf-8" },
    ).trim();
    if (nextTrigger && nextTrigger !== "0" && nextTrigger !== "") {
      console.log(`  Next trigger:   ${nextTrigger}`);
    } else {
      console.log("  Next trigger:   pending");
    }
  } catch {
    console.log("  Next trigger:   unknown");
  }

  // Last service result
  try {
    const result = execSync(
      'systemctl --user show ega-devtrack.service -p ExecMainStatus --value',
      { encoding: "utf-8" },
    ).trim();
    if (result === "0") {
      console.log("  Last run result: success");
    } else if (result !== "") {
      console.log(`  Last run result: exit code ${result}`);
    }
  } catch {
    // service may never have run
  }

  console.log("");

  // ── Caveat ───────────────────────────────────────────────────
  console.log("  Upload mode: `ega-devtrack once --upload` sends data to the server.");
  console.log("  Check `journalctl --user -u ega-devtrack.service` for logs.\n");
}

// ── OpenCode Go Manual Usage ──────────────────────────────────────

async function cmdOpenCodeGoManual(): Promise<void> {
  const subcommand = args[1];

  if (subcommand !== "manual") {
    console.error("ERROR: opencode-go command requires 'manual' subcommand.");
    console.error("  Usage: ega-devtrack opencode-go manual --rolling-used-pct N --weekly-used-pct N --monthly-used-pct N [--rolling-reset TEXT] [--weekly-reset TEXT] [--monthly-reset TEXT]");
    process.exit(1);
  }

  const rollingUsed = argValue("--rolling-used-pct");
  const weeklyUsed = argValue("--weekly-used-pct");
  const monthlyUsed = argValue("--monthly-used-pct");

  if (!rollingUsed || !weeklyUsed || !monthlyUsed) {
    console.error("ERROR: --rolling-used-pct, --weekly-used-pct, and --monthly-used-pct are required.");
    process.exit(1);
  }

  const rollingReset = argValue("--rolling-reset") ?? undefined;
  const weeklyReset = argValue("--weekly-reset") ?? undefined;
  const monthlyReset = argValue("--monthly-reset") ?? undefined;

  const rolling = Number(rollingUsed);
  const weekly = Number(weeklyUsed);
  const monthly = Number(monthlyUsed);

  if (!Number.isFinite(rolling) || !Number.isFinite(weekly) || !Number.isFinite(monthly)) {
    console.error("ERROR: usage percentages must be valid numbers.");
    process.exit(1);
  }

  const { buildOpenCodeGoManualSnapshots } = await import("../src/agent/collectors/opencode");
  const config = readAgentConfig();
  const snapshots = buildOpenCodeGoManualSnapshots({
    rollingUsedPct: rolling, weeklyUsedPct: weekly, monthlyUsedPct: monthly,
    rollingReset, weeklyReset, monthlyReset,
  });

  const deviceFingerprint = config.deviceFingerprint ?? deriveDeviceFingerprint(getDeviceName(), process.platform);
  const { sanitize } = await import("../src/agent/sanitizer");

  const payload = sanitize({
    device: { deviceFingerprint, agentVersion: "0.1.0", os: process.platform },
    quotaPoolSnapshots: snapshots,
    toolQuotaAttributions: [],
    toolInfos: [{
      toolType: "opencode",
      displayName: "OpenCode CLI (OpenCode Go)",
      agentFingerprint: `opencode-opencode-go-manual-${deviceFingerprint.slice(0, 8)}`,
      metadata: JSON.stringify({ usageStatus: "manual_confirmed", pool: "OpenCode Go", manualSource: "screenshot" }),
    }],
  });

  const deviceToken = getDeviceToken(config);
  if (!deviceToken) {
    console.error("ERROR: Device not registered. Run: ega-devtrack register --token <bootstrap-token>");
    process.exit(1);
  }

  const apiBaseUrl = getApiBaseUrl(config);
  const uploadUrl = `${apiBaseUrl}/api/ingest`;

  console.log(`[agent] Uploading OpenCode Go manual usage to: ${uploadUrl}`);
  for (const s of snapshots) {
    console.log(`  ${s.windowName}: ${s.usageAmount}% (source: ${s.source}, confidence: ${s.confidence})`);
  }

  try {
    const response = await fetch(uploadUrl, {
      method: "POST", headers: authHeaders(deviceToken), body: JSON.stringify(payload),
    });
    if (response.ok) {
      console.log("[agent] Manual OpenCode Go usage uploaded SUCCESS");
    } else {
      const text = await response.text().catch(() => "unknown");
      console.error(`[agent] Upload FAILED (HTTP ${response.status}): ${text}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`[agent] Upload NETWORK ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// ── Codex Manual Usage ─────────────────────────────────────────────

async function cmdCodexManual(): Promise<void> {
  const subcommand = args[1];

  if (subcommand !== "manual") {
    console.error("ERROR: codex command requires 'manual' subcommand.");
    console.error("  Usage: ega-devtrack codex manual --five-hour-remaining-pct N --weekly-remaining-pct N --credits-remaining N [--five-hour-reset TEXT] [--weekly-reset TEXT]");
    process.exit(1);
  }

  const fiveHourRemaining = argValue("--five-hour-remaining-pct");
  const weeklyRemaining = argValue("--weekly-remaining-pct");
  const creditsRemaining = argValue("--credits-remaining");

  if (!fiveHourRemaining || !weeklyRemaining || creditsRemaining === null) {
    console.error("ERROR: --five-hour-remaining-pct, --weekly-remaining-pct, and --credits-remaining are required.");
    process.exit(1);
  }

  const fiveHour = Number(fiveHourRemaining);
  const weekly = Number(weeklyRemaining);
  const credits = Number(creditsRemaining);

  if (!Number.isFinite(fiveHour) || !Number.isFinite(weekly) || !Number.isFinite(credits)) {
    console.error("ERROR: Codex manual values must be valid numbers.");
    process.exit(1);
  }

  const { buildCodexManualSnapshots } = await import("../src/agent/collectors/codex");
  const config = readAgentConfig();
  const snapshots = buildCodexManualSnapshots({
    fiveHourRemainingPct: fiveHour,
    weeklyRemainingPct: weekly,
    creditsRemaining: credits,
    fiveHourReset: argValue("--five-hour-reset") ?? undefined,
    weeklyReset: argValue("--weekly-reset") ?? undefined,
  });

  const deviceFingerprint = config.deviceFingerprint ?? deriveDeviceFingerprint(getDeviceName(), process.platform);
  const { sanitize } = await import("../src/agent/sanitizer");
  const payload = sanitize({
    device: { deviceFingerprint, agentVersion: "0.1.0", os: process.platform },
    quotaPoolSnapshots: snapshots,
    toolQuotaAttributions: [],
    toolInfos: [{
      toolType: "codex",
      displayName: "Codex CLI",
      agentFingerprint: `codex-manual-${deviceFingerprint.slice(0, 8)}`,
      metadata: JSON.stringify({ usageStatus: "manual_confirmed", pool: "Codex", manualSource: "screenshot" }),
    }],
  });

  const deviceToken = getDeviceToken(config);
  if (!deviceToken) {
    console.error("ERROR: Device not registered. Run: ega-devtrack register --token <bootstrap-token>");
    process.exit(1);
  }

  const apiBaseUrl = getApiBaseUrl(config);
  const uploadUrl = `${apiBaseUrl}/api/ingest`;

  console.log(`[agent] Uploading Codex manual usage to: ${uploadUrl}`);
  for (const s of snapshots) {
    const valueLabel = s.windowName === "codex-credits" ? `${s.usageAmount} remaining` : `${s.usageAmount}% used`;
    console.log(`  ${s.windowName}: ${valueLabel} (source: ${s.source}, confidence: ${s.confidence})`);
  }

  try {
    const response = await fetch(uploadUrl, {
      method: "POST", headers: authHeaders(deviceToken), body: JSON.stringify(payload),
    });
    if (response.ok) {
      console.log("[agent] Manual Codex usage uploaded SUCCESS");
    } else {
      const text = await response.text().catch(() => "unknown");
      console.error(`[agent] Upload FAILED (HTTP ${response.status}): ${text}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`[agent] Upload NETWORK ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// ── Stale Window Cleanup ───────────────────────────────────────────

async function cmdCleanup(): Promise<void> {
  const subcommand = args[1];
  if (subcommand !== "stale-windows") {
    console.error("ERROR: cleanup command requires 'stale-windows' subcommand.");
    console.error("  Usage: ega-devtrack cleanup stale-windows --dry-run|--apply");
    process.exit(1);
  }

  const apply = args.includes("--apply");
  const dryRun = args.includes("--dry-run");
  if (apply === dryRun) {
    console.error("ERROR: choose exactly one of --dry-run or --apply.");
    process.exit(1);
  }

  const config = readAgentConfig();
  const deviceToken = getDeviceToken(config);
  if (!deviceToken) {
    console.error("ERROR: Device not registered. Run: ega-devtrack register --token <bootstrap-token>");
    process.exit(1);
  }

  const apiBaseUrl = getApiBaseUrl(config);
  const cleanupUrl = `${apiBaseUrl}/api/cleanup/stale-windows`;
  const response = await fetch(cleanupUrl, {
    method: "POST",
    headers: authHeaders(deviceToken),
    body: JSON.stringify({ apply }),
  });

  const body = await response.json().catch(() => ({})) as {
    staleWindowCount?: number;
    deletedCount?: number;
    windowNames?: string[];
    error?: string;
  };

  if (!response.ok) {
    console.error(`[agent] Cleanup FAILED (HTTP ${response.status}): ${body.error ?? "unknown"}`);
    process.exit(1);
  }

  console.log(`[agent] Stale window cleanup ${apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`  Matched: ${body.staleWindowCount ?? 0}`);
  console.log(`  Deleted current_state rows: ${body.deletedCount ?? 0}`);
  for (const name of body.windowNames ?? []) {
    console.log(`  ${name}`);
  }
}

// ── Usage Collection (with experimental browser collectors) ──────

async function cmdUsageCollect(): Promise<void> {
  const subcommand = args[1];

  if (subcommand !== "collect") {
    console.error("ERROR: usage command requires 'collect' subcommand.");
    console.error("  Usage: ega-devtrack usage collect --dry-run");
    console.error("         ega-devtrack usage collect --upload");
    process.exit(1);
  }

  const isDryRun = args.includes("--dry-run");
  const isUpload = args.includes("--upload");

  if (!isDryRun && !isUpload) {
    console.error("ERROR: usage collect requires --dry-run or --upload.");
    process.exit(1);
  }

  const config = readAgentConfig();

  if (isDryRun) {
    const result = await runAllCollectors({
      deviceFingerprint: config.deviceFingerprint ?? deriveDeviceFingerprint(getDeviceName(), process.platform),
      agentVersion: "0.1.0", os: process.platform,
    });

    printUsageSummary(result.payload.quotaPoolSnapshots);

    console.log(JSON.stringify({
      dryRun: true,
      timestamp: new Date().toISOString(),
      experimental: {
        codexBrowser: process.env.DEVTRACK_EXPERIMENTAL_CODEX_BROWSER_USAGE === "1",
        opencodeGoBrowser: process.env.DEVTRACK_EXPERIMENTAL_OPENCODE_GO_BROWSER_USAGE === "1",
      },
      collectors: { run: result.collectorsRun, failed: result.collectorsFailed },
      errors: result.errors.length > 0 ? result.errors : undefined,
      notice: "DRY RUN — No data was uploaded. Summary above is for preview only.",
    }, null, 2));
    process.exit(0);
  }

  // Upload mode
  const deviceToken = getDeviceToken(config);
  if (!deviceToken) {
    console.error("ERROR: Device not registered.");
    process.exit(1);
  }

  const apiBaseUrl = getApiBaseUrl(config);
  const uploadUrl = `${apiBaseUrl}/api/ingest`;

  const result = await runAllCollectors({
    deviceFingerprint: config.deviceFingerprint ?? deriveDeviceFingerprint(getDeviceName(), process.platform),
    agentVersion: "0.1.0", os: process.platform,
  });

  printUsageSummary(result.payload.quotaPoolSnapshots);

  try {
    const response = await fetch(uploadUrl, {
      method: "POST", headers: authHeaders(deviceToken), body: JSON.stringify(result.payload),
    });
    if (response.ok) {
      console.log("[agent] Usage upload SUCCESS");
    } else {
      const text = await response.text().catch(() => "unknown");
      console.warn(`[agent] Upload FAILED (HTTP ${response.status}): ${text}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`[agent] Upload NETWORK ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

function printUsageSummary(snapshots: { windowName: string; usageAmount: number; source?: string; confidence?: number }[]): void {
  console.log("\\n  === Usage Summary ===");

  const codex = snapshots.filter((s) => s.windowName.startsWith("codex-"));
  const opencode = snapshots.filter((s) => s.windowName.startsWith("opencode-go-"));

  if (codex.length > 0) {
    console.log("  Codex:");
    for (const s of codex) {
      const label = s.windowName.replace("codex-", "");
      if (s.usageAmount < 0) {
        console.log(`    ${label}: unknown (source: ${s.source ?? "—"})`);
      } else {
        console.log(`    ${label}: ${s.usageAmount}% used (source: ${s.source ?? "—"}, confidence: ${s.confidence ?? "—"})`);
      }
    }
  }

  if (opencode.length > 0) {
    console.log("  OpenCode Go:");
    for (const s of opencode) {
      const label = s.windowName.replace("opencode-go-", "");
      if (s.usageAmount < 0) {
        console.log(`    ${label}: unknown (source: ${s.source ?? "—"})`);
      } else {
        console.log(`    ${label}: ${s.usageAmount}% used (source: ${s.source ?? "—"}, confidence: ${s.confidence ?? "—"})`);
      }
    }
  }

  console.log("");
}

// ── Verify ─────────────────────────────────────────────────────────

async function cmdVerify(): Promise<void> {
  const config = readAgentConfig();
  const apiBaseUrl = getApiBaseUrl(config);
  const isRegistered = !!getDeviceToken(config);

  console.log("");
  console.log("  ega-devtrack — Real Data Verification");
  console.log("  ─────────────────────────────────────");

  // 1. Registered?
  console.log(`  Registered:       ${isRegistered ? "YES" : "NO"}`);
  if (!isRegistered) {
    console.log("  → Run: ega-devtrack register --token <bootstrap-token>");
  }
  // Print config existence (not the token itself)
  const configExists = existsSync(configPath());
  console.log(`  Config file:      ${configExists ? "EXISTS" : "MISSING"} (${configPath().replace(homedir(), "~")})`);

  // 2. Check upload reachable
  try {
    const freshenssUrl = `${apiBaseUrl.replace(/\/+$/, "")}/api/status/data-freshness`;
    const response = await fetch(freshenssUrl, { signal: AbortSignal.timeout(10_000) });

    if (response.ok) {
      const data = (await response.json()) as Record<string, unknown>;
      console.log(`  Upload reachable: YES (${apiBaseUrl})`);
      console.log(`  Dashboard mode:   ${data.mode ?? "unknown"}`);
      console.log(`  Devices:          ${String(data.deviceCount ?? "?")}`);
      console.log(`  Windows tracked:  ${String(data.currentStateCount ?? "?")}`);
      console.log(`  Stale windows:    ${String(data.staleWindowCount ?? "?")}`);

      const receivedAt = data.latestReceivedAt as string | null;
      const collectedAt = data.latestCollectedAt as string | null;

      if (receivedAt) {
        const ageMin = Math.floor((Date.now() - new Date(receivedAt).getTime()) / 60000);
        console.log(`  Last received:    ${ageMin < 1 ? "Just now" : `${ageMin}m ago`} (${receivedAt})`);
      } else {
        console.log(`  Last received:    Never`);
      }

      if (collectedAt) {
        const ageMin = Math.floor((Date.now() - new Date(collectedAt).getTime()) / 60000);
        console.log(`  Last uploaded:    ${ageMin < 1 ? "Just now" : `${ageMin}m ago`} (${collectedAt})`);
      } else {
        console.log(`  Last uploaded:    Never`);
      }

      const sources = data.sources as string[] | undefined;
      if (sources && sources.length > 0) {
        console.log(`  Data sources:     ${sources.join(", ")}`);
      }

      const staleWindows = data.staleWindows as Array<Record<string, unknown>> | undefined;
      if (staleWindows && staleWindows.length > 0) {
        console.log("  Stale windows:");
        for (const w of staleWindows.slice(0, 5)) {
          console.log(`    ${String(w.windowName)}: ${String(w.ageMin)}m old`);
        }
      }
    } else {
      console.log(`  Upload reachable: HTTP ${response.status} (${apiBaseUrl})`);
    }
  } catch (err) {
    console.log(`  Upload reachable: ERROR — ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. Scheduler
  try {
    execSync("systemctl --user is-active ega-devtrack.timer", { stdio: "ignore" });
    console.log("  Scheduler:        ACTIVE (every 15 min)");
  } catch {
    try {
      execSync("systemctl --user is-enabled ega-devtrack.timer", { stdio: "ignore" });
      console.log("  Scheduler:        INSTALLED but INACTIVE");
      console.log("  → Run: ega-devtrack install");
    } catch {
      console.log("  Scheduler:        NOT INSTALLED");
      console.log("  → Run: ega-devtrack install");
    }
  }

  // 4. Recommendations
  console.log("");
  console.log("  Next recommended command:");
  if (!isRegistered) {
    console.log("    ega-devtrack register --token <bootstrap-token>");
  } else {
    console.log("    ega-devtrack once --upload    # Refresh data now");
    console.log("    ega-devtrack status           # Check scheduler + spool");
  }
  console.log("  Dashboard:        https://ai-quota-pool-tracker.vercel.app/dashboard");
  console.log("");
}

// ── Main dispatch ────────────────────────────────────────────────────

async function main(): Promise<void> {
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    showHelp();
    process.exit(0);
  }

  if (command === "privacy-report") {
    printPrivacyReport();
    process.exit(0);
  }

  if (command === "register") {
    await cmdRegister();
    process.exit(0);
  }

  if (command === "install") {
    await cmdInstall();
    process.exit(0);
  }

  if (command === "uninstall") {
    await cmdUninstall();
    process.exit(0);
  }

  if (command === "status") {
    await cmdStatus();
    process.exit(0);
  }

  if (command === "opencode-go") {
    await cmdOpenCodeGoManual();
    process.exit(0);
  }

  if (command === "codex") {
    await cmdCodexManual();
    process.exit(0);
  }

  if (command === "cleanup") {
    await cmdCleanup();
    process.exit(0);
  }

  if (command === "usage") {
    await cmdUsageCollect();
    process.exit(0);
  }

  if (command === "verify") {
    await cmdVerify();
    process.exit(0);
  }

  if (command === "once") {
    const isDryRun = args.includes("--dry-run");
    const isUpload = args.includes("--upload");

    if (!isDryRun && !isUpload) {
      console.error(
        "ERROR: The 'once' command requires either --dry-run or --upload.\n" +
        "  Run: ega-devtrack once --dry-run  (preview only, no upload)\n" +
        "  Run: ega-devtrack once --upload   (collect + upload to server)",
      );
      process.exit(1);
    }

    if (isDryRun) {
      // ── Dry Run Mode ───────────────────────────────────────
      const config = readAgentConfig();
      const result = await runAllCollectors({
        deviceFingerprint:
          config.deviceFingerprint ?? deriveDeviceFingerprint(getDeviceName(), process.platform),
        agentVersion: "0.1.0",
        os: process.platform,
      });

      const output = {
        dryRun: true,
        timestamp: new Date().toISOString(),
        payload: result.payload,
        collectors: {
          run: result.collectorsRun,
          failed: result.collectorsFailed,
        },
        errors: result.errors.length > 0 ? result.errors : undefined,
        notice: "DRY RUN — No data was uploaded. All values have been sanitized.",
      };

      console.log(JSON.stringify(output, null, 2));

      // Dry-run always exits 0 — even when collectors fail
      process.exit(0);
    }

    // ── Upload Mode ──────────────────────────────────────────
    const config = readAgentConfig();
    const deviceToken = getDeviceToken(config);
    if (!deviceToken) {
      console.error(
        "ERROR: Device not registered. Run: ega-devtrack register --token <bootstrap-token>",
      );
      process.exit(1);
    }

    const apiBaseUrl = getApiBaseUrl(config);
    const uploadUrl = `${apiBaseUrl.replace(/\/+$/, "")}/api/ingest`;

    console.log(`[agent] Upload mode — endpoint: ${uploadUrl}`);

    // Step 1: Retry spooled items (oldest first)
    const spooledEntries = readSpool();
    if (spooledEntries.length > 0) {
      console.log(`[agent] Retrying ${spooledEntries.length} spooled upload(s)...`);
      for (const entry of spooledEntries) {
        try {
          const response = await fetch(uploadUrl, {
            method: "POST",
            headers: authHeaders(deviceToken),
            body: JSON.stringify(entry.payload),
          });

          if (response.ok) {
            console.log(`[agent] Spool retry SUCCESS: ${entry.id}`);
            deleteSpoolEntry(entry.id);
          } else {
            const text = await response.text().catch(() => "unknown");
            console.warn(`[agent] Spool retry FAILED (HTTP ${response.status}): ${entry.id} — ${text}`);
            // Update retry count in the file
            entry.retryCount++;
            entry.lastRetryAt = new Date().toISOString();
            const updatedEntry = {
              ...entry,
              lastRetryAt: new Date().toISOString(),
              retryCount: entry.retryCount,
            };
            const { join } = await import("node:path");
            const { homedir } = await import("node:os");
            const spoolDir = join(homedir(), ".local", "share", "ega-devtrack", "spool");
            const { writeFileSync } = await import("node:fs");
            writeFileSync(join(spoolDir, `${entry.id}.json`), JSON.stringify(updatedEntry, null, 2), "utf-8");
          }
        } catch (err) {
          console.warn(`[agent] Spool retry ERROR: ${entry.id} — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } else {
      console.log("[agent] No spooled items to retry.");
    }

    // Step 2: Collect fresh data
    const collectorResult = await runAllCollectors({
      deviceFingerprint:
        config.deviceFingerprint ?? deriveDeviceFingerprint(getDeviceName(), process.platform),
      agentVersion: "0.1.0",
      os: process.platform,
    });
    console.log(
      `[agent] Collected data: ${collectorResult.collectorsRun} collectors run, ${collectorResult.collectorsFailed} failed`,
    );

    for (const err of collectorResult.errors) {
      console.warn(`[agent] Collector error: ${err}`);
    }

    // Step 3: Upload fresh payload
    try {
      const response = await fetch(uploadUrl, {
        method: "POST",
        headers: authHeaders(deviceToken),
        body: JSON.stringify(collectorResult.payload),
      });

      if (response.ok) {
        console.log("[agent] Upload SUCCESS");
        console.log(JSON.stringify({ uploaded: true, timestamp: new Date().toISOString() }, null, 2));
        process.exit(0);
      } else {
        const text = await response.text().catch(() => "unknown");
        console.warn(`[agent] Upload FAILED (HTTP ${response.status}): ${text}`);

        // Spool the failed payload for later retry
        const spoolId = writeSpool(collectorResult.payload);
        if (spoolId) {
          console.log(`[agent] Payload spooled as: ${spoolId}`);
        } else {
          console.warn("[agent] Failed to spool payload (spool may be full)");
        }

        process.exit(1);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[agent] Upload NETWORK ERROR: ${message}`);

      // Spool the failed payload for later retry
      const spoolId = writeSpool(collectorResult.payload);
      if (spoolId) {
        console.log(`[agent] Payload spooled as: ${spoolId}`);
      } else {
        console.warn("[agent] Failed to spool payload (spool may be full)");
      }

      process.exit(1);
    }
  }

  // Unknown command
  console.error(`Unknown command: "${command}"`);
  console.error("Run 'ega-devtrack --help' for usage.");
  process.exit(1);
}

main().catch((err) => {
  console.error("Fatal error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
