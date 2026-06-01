#!/usr/bin/env node

/**
 * ega-devtrack — AI Quota Pool Tracker agent CLI.
 *
 * Commands:
 *   once --dry-run           Run collectors and print normalized payload (no upload)
 *   privacy-report           Print what's uploaded vs never uploaded
 *   --help                   Show this help
 *
 * All dry-run output is sanitized — no raw tokens/secrets appear.
 * Dry-run always exits 0 even when collectors fail.
 */

import { runAllCollectors } from "../src/agent/collectors/index";
import { printPrivacyReport } from "../src/agent/privacy-report";

const args = process.argv.slice(2);

function showHelp(): void {
  console.log(`
  ega-devtrack — AI Quota Pool Tracker Agent

  USAGE:
    ega-devtrack once --dry-run         Collect & print normalized payload (no upload)
    ega-devtrack privacy-report         Print privacy report
    ega-devtrack --help                 Show this help

  OPTIONS:
    --dry-run   Run collectors and output normalized payload to stdout.
                Everything is sanitized. NO data is uploaded.
                Exits 0 even if collectors fail.

  PRIVACY:
    The agent NEVER uploads: tokens, keys, secrets, prompts,
    completions, source code, cookies, auth files, shell history,
    or any PII. See \`ega-devtrack privacy-report\` for details.

  EXAMPLES:
    ega-devtrack once --dry-run
    ega-devtrack privacy-report
`.trim());
}

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
