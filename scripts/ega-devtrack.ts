#!/usr/bin/env node

/**
 * ega-devtrack — AI Quota Pool Tracker agent CLI.
 *
 * Commands:
 *   once --dry-run           Run collectors and print normalized payload (no upload)
 *   privacy-report           Print what's uploaded vs never uploaded
 *   install                  Install systemd timer to run agent every 15 minutes
 *   uninstall                Remove the systemd timer and service
 *   status                   Show scheduler status (last/next run, timer state)
 *   --help                   Show this help
 *
 * All dry-run output is sanitized — no raw tokens/secrets appear.
 * Dry-run always exits 0 even when collectors fail.
 */

import { runAllCollectors } from "../src/agent/collectors/index";
import { printPrivacyReport } from "../src/agent/privacy-report";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const args = process.argv.slice(2);

function showHelp(): void {
  console.log(`
  ega-devtrack — AI Quota Pool Tracker Agent

  USAGE:
    ega-devtrack once --dry-run         Collect & print normalized payload (no upload)
    ega-devtrack privacy-report         Print privacy report
    ega-devtrack install                Install systemd timer (runs every 15 min)
    ega-devtrack uninstall              Remove installed systemd timer & service
    ega-devtrack status                 Show scheduler status
    ega-devtrack --help                 Show this help

  OPTIONS:
    --dry-run   Run collectors and output normalized payload to stdout.
                Everything is sanitized. NO data is uploaded.
                Exits 0 even if collectors fail.

  SCHEDULER (install / uninstall / status):
    Linux: Creates systemd user service + timer units at
           ~/.config/systemd/user/ega-devtrack.{service,timer}
           and enables them with \`systemctl --user\`.
           The timer triggers \`ega-devtrack once\` every 15 minutes.

           NOTE: The 'once' command currently requires --dry-run,
           so scheduled runs will fail until upload mode is implemented.
           This is a known limitation.

    Windows: Not yet supported (cross-platform support planned).

  PRIVACY:
    The agent NEVER uploads: tokens, keys, secrets, prompts,
    completions, source code, cookies, auth files, shell history,
    or any PII. See \`ega-devtrack privacy-report\` for details.

  EXAMPLES:
    ega-devtrack once --dry-run
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
ExecStart=${cliJs} once --dry-run
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
  console.log("  NOTE: The 'once' command currently requires --dry-run.");
  console.log("  Scheduled runs will log collection data to journal but");
  console.log("  will NOT upload until upload mode is implemented.");
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

  if (!timerExists && !serviceExists) {
    console.log("\n  Status: NOT INSTALLED");
    console.log("  Run \`ega-devtrack install\` to set up the scheduler.\n");
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
  console.log("  NOTE: The 'once' command currently requires --dry-run,");
  console.log("  so scheduled runs log data but do not upload.");
  console.log("  Check \`journalctl --user -u ega-devtrack.service\` for logs.\n");
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

  if (command === "once") {
    const isDryRun = args.includes("--dry-run");

    if (!isDryRun) {
      console.error(
        "ERROR: The 'once' command requires --dry-run until upload mode is implemented.\n" +
        "Run: ega-devtrack once --dry-run",
      );
      process.exit(1);
    }

    // ── Dry Run Mode ───────────────────────────────────────
    const result = await runAllCollectors();

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

  // Unknown command
  console.error(`Unknown command: "${command}"`);
  console.error("Run 'ega-devtrack --help' for usage.");
  process.exit(1);
}

main().catch((err) => {
  console.error("Fatal error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
