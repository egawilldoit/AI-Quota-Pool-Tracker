# AI Quota Pool Tracker — DevTrack Agent

> **Status:** MVP · Agent: `ega-devtrack` (CLI)  
> **Repository:** https://github.com/egawilldoit/AI-Quota-Pool-Tracker

---

## Table of Contents

1. [What Is a Quota Pool?](#what-is-a-quota-pool)
2. [How Tools Are Tracked](#how-tools-are-tracked)
   - [Codex / ChatGPT](#codex--chatgpt)
   - [OpenCode Go](#opencode-go)
   - [Hermes Agent](#hermes-agent)
   - [Manual Usage Fallback](#manual-usage-fallback)
3. [Privacy & Data Boundary](#privacy--data-boundary)
   - [What the Agent Uploads](#what-the-agent-uploads)
   - [What the Agent NEVER Uploads](#what-the-agent-never-uploads)
   - [How Data Is Sanitized](#how-data-is-sanitized)
4. [Setup Instructions](#setup-instructions)
   - [Prerequisites](#prerequisites)
   - [Environment Variables](#environment-variables)
   - [Supabase Setup](#supabase-setup)
   - [Drizzle Database Setup](#drizzle-database-setup)
   - [Build the Agent](#build-the-agent)
5. [CLI Commands](#cli-commands)
   - [once --dry-run](#once---dry-run)
   - [once --upload](#once---upload)
   - [privacy-report](#privacy-report)
   - [install (Linux)](#install-linux)
   - [install (Windows)](#install-windows)
   - [uninstall](#uninstall)
   - [status](#status)
   - [npm Script Shortcuts](#npm-script-shortcuts)
6. [Troubleshooting](#troubleshooting)
   - [Stale Device](#stale-device)
   - [Token Revoke / Rotate](#token-revoke--rotate)
   - [Deferred Features](#deferred-features)

---

## What Is a Quota Pool?

A **quota pool** is a virtual bucket that tracks consumption of AI credits across tools and time windows. Each pool belongs to a workspace and is identified by a unique UUID. Pools track usage in named windows — for example `2026-06-monthly` — and record the amount consumed, the time boundaries, and a confidence score for the measurement.

The system supports these built-in pools:

| Pool ID (UUID)                            | Pool Name        | Description                                                    |
|-------------------------------------------|------------------|----------------------------------------------------------------|
| `00000000-0000-0000-0000-000000000001`    | Codex-ChatGPT    | OpenAI/ChatGPT usage via Codex CLI (paid model detection)      |
| `00000000-0000-0000-0000-000000000002`    | OpenCode Go      | Usage via OpenCode CLI with `opencode-go/` provider prefix     |
| `00000000-0000-0000-0000-000000000003`    | OpenAI Provider  | Usage via any tool configured with the `openai` provider       |
| `00000000-0000-0000-0000-000000000004`    | Free / Unknown   | Usage via free-tier models or providers that could not be classified |

You can create additional custom pools via the [dashboard](/dashboard) for any workspace.

---

## How Tools Are Tracked

### Codex / ChatGPT

The agent detects Codex CLI by reading `~/.codex/config.toml` — specifically the top-level `model = "..."` field (e.g. `gpt-5.5`). It also attempts safe CLI status collection:

1. `codex status --json` if supported
2. `codex status` text parsing as fallback
3. Model-only heartbeat if no machine-readable usage is available

- **Model classification:** Models starting with `gpt-`, `o1`, `o3`, or `o4` are classified as **high-confidence paid** (confidence 0.9) and mapped to the **Codex-ChatGPT** pool.
- All other models are classified as moderate confidence (0.7).
- **Usage:** Status parsing records percent-style usage only when the CLI exposes it. Otherwise usage amount is `0` with source `heartbeat`.
- **Privacy:** Only the model name is read. The agent **never** reads or uploads `~/.codex/auth.json` (contains tokens).
- If Codex is not installed or config is missing, the agent records a `detected: false` ToolInfo and produces no snapshots.

### OpenCode Go

The agent runs `opencode models` as a subprocess and parses the model list to detect the active provider.

- **Provider classification:**
  - Models prefixed `opencode-go/` → **OpenCode Go** pool (confidence 0.8)
  - Models prefixed `openai/` → **OpenAI Provider** pool (confidence 0.7)
  - Models prefixed `opencode/` → **Free** pool (confidence 0.5)
  - Other providers are ignored — the agent cannot classify them with confidence
- **Current auth reality:** OpenCode Go uses an API-key style connection flow (`opencode auth` / OpenCode Zen `/connect`). The agent does not read those API keys.
- **Usage:** No stable official machine-readable OpenCode Go usage endpoint is implemented here. The collector classifies provider/model and marks usage as `unknown_manual_required`.
- **Privacy:** Only the model names from `opencode models` are parsed. The agent **never** reads `auth.json`, `config.jsonc`, API keys, or any file containing tokens or secrets.
- If `opencode` is not on `$PATH` or the command fails, the collector returns empty data gracefully.

### Hermes Agent

The agent reads `~/.hermes/config.yaml` to determine the active provider and model used by Hermes.

- **Provider classification:**
  - `provider: opencode-go` → **OpenCode Go** pool (confidence 0.8)
  - `provider: openai` → **OpenAI Provider** pool (confidence 0.7)
  - `provider: openrouter` with model starting `openai/` → **OpenAI Provider** pool (confidence 0.7)
  - Model ending in `:free` → **Free** pool (confidence 0.5)
  - All others → **Unknown** pool (confidence 0.3)
- **Privacy:** Only the `provider` and `model` fields from the `delegation` or `model.default` section of `config.yaml` are extracted. The agent **never** reads `~/.hermes/.env` (contains API keys), memory files, session files, prompts, or completions.
- **Usage:** Hermes provider/model routing is attributed to the matching pool. If Hermes routes through OpenCode Go, it is attributed to OpenCode Go. Usage amount remains unknown/manual unless the upstream provider exposes safe usage data.
- If Hermes is not installed or config is missing, the agent records `detected: false` and produces no snapshots.

### Manual Usage Fallback

When the agent cannot reliably detect usage for a specific tool or provider, users can record usage manually through the web interface:

1. Navigate to **Dashboard** → select a workspace → **Manual Usage**
2. URL pattern: `/workspaces/[workspaceId]/manual-usage/new`
3. Enter the usage amount, select the quota pool, and optionally add a description.

Manual entries are recorded with `source: "manual"` and full confidence (1.0).

---

## Privacy & Data Boundary

The DevTrack agent runs locally on your machine. It collects only what is necessary for quota tracking and **never** sends sensitive data to the server.

### What the Agent Uploads

These are the exact fields sent to the API endpoint (`POST /api/ingest`):

#### Device Info
| Field                          | Description                                                |
|--------------------------------|------------------------------------------------------------|
| `device.deviceFingerprint`     | Stable device identifier (hostname + OS hash, SHA-256)     |
| `device.agentVersion`          | Agent software version string                              |
| `device.os`                    | Operating system platform string (e.g. `linux`, `darwin`)  |

#### Quota Pool Snapshots
| Field                                        | Description                                           |
|----------------------------------------------|-------------------------------------------------------|
| `quotaPoolSnapshots[].quotaPoolId`           | UUID of the quota pool on the server                  |
| `quotaPoolSnapshots[].windowName`            | Usage window label (e.g. `2026-06-monthly`)           |
| `quotaPoolSnapshots[].usageAmount`           | Numeric usage amount                                  |
| `quotaPoolSnapshots[].windowStart`           | ISO-8601 start of usage window                        |
| `quotaPoolSnapshots[].windowEnd`             | ISO-8601 end of usage window                          |
| `quotaPoolSnapshots[].idempotencyKey`        | Deduplication key                                     |
| `quotaPoolSnapshots[].source`                | Source label (`heartbeat`, `manual`, `import`)        |
| `quotaPoolSnapshots[].confidence`            | Confidence score 0–1                                  |

#### Tool Quota Attributions
| Field                                            | Description                                    |
|--------------------------------------------------|------------------------------------------------|
| `toolQuotaAttributions[].toolInstanceFingerprint` | Tool fingerprint (matches `agentFingerprint`)  |
| `toolQuotaAttributions[].quotaPoolId`            | UUID of the quota pool                         |
| `toolQuotaAttributions[].allocatedAmount`        | Numeric allocated quota amount                 |

#### Tool Info
| Field                             | Description                                                  |
|-----------------------------------|--------------------------------------------------------------|
| `toolInfos[].toolType`            | AI tool type string (`codex`, `opencode`, `hermes`, etc.)    |
| `toolInfos[].displayName`         | Human-readable display name                                  |
| `toolInfos[].agentFingerprint`    | Stable tool instance identifier                              |
| `toolInfos[].metadata`            | JSON blob (version, mode, model — **never** raw secrets)     |

#### Codex-Specific Fields
| Field                        | Description                                                              |
|------------------------------|--------------------------------------------------------------------------|
| `codex model name`           | Model name from `~/.codex/config.toml` (e.g. `gpt-5.5`)                  |
| `codex tool type`            | Tool type identifier `codex` for the Codex CLI                           |
| `codex detection status`     | Whether Codex CLI and config.toml were detected on the machine           |

#### OpenCode-Specific Fields
| Field                          | Description                                                                 |
|--------------------------------|-----------------------------------------------------------------------------|
| `opencode models list`         | Model names from `opencode models` output                                   |
| `opencode detected providers`  | Unique provider prefixes parsed from model names                            |
| `opencode classified pool`     | Quota pool assignment based on detected providers                           |
| `opencode models count`        | Total number of available models (numeric only)                             |

#### Hermes-Specific Fields
| Field                         | Description                                               |
|-------------------------------|-----------------------------------------------------------|
| `hermes provider`             | Provider name from `config.yaml` delegation section       |
| `hermes model`                | Model name from `config.yaml` delegation section          |
| `hermes classified pool`      | Quota pool assignment based on provider/model mapping     |
| `hermes detection status`     | Whether Hermes `config.yaml` was detected on the machine  |

### What the Agent NEVER Uploads

The following are **never collected, read, or uploaded**:

| Category            | Description                                                       |
|---------------------|-------------------------------------------------------------------|
| API keys / tokens   | All raw API keys (`sk-*`, `tok_*`, `lin_api_*`, etc.) are redacted or never collected  |
| Prompts / completions | Agent does not collect any prompt or completion text              |
| Source code         | No source code files are read or uploaded                         |
| Cookies             | Browser cookies are never accessed                                |
| Auth files          | `~/.ssh/*`, `~/.config/*` credentials, `.env` files not collected |
| Shell history       | `~/.bash_history`, `~/.zsh_history` never read                    |
| Personal data       | No names, emails, addresses, or PII collected                     |
| Private keys        | No SSH keys, GPG keys, or certificate private keys                |
| Raw config files    | Config files may be examined for usage counts only; raw values redacted |
| Device exact hostname | Fingerprints are hashed/derived, not raw hostnames              |
| Network info        | No IP addresses, MAC addresses, or network topology               |

### How Data Is Sanitized

All collected data passes through a `sanitize()` function before being returned by any collector or written to the spool. This function:

- Redacts anything that looks like an API key or token (`sk-*`, `tok_*`, etc.)
- Strips path information from file references
- Ensures no raw secrets leak into the payload output
- Runs on both dry-run and upload mode

---

## Setup Instructions

### Prerequisites

- **Node.js** 20+ and **npm**
- **PostgreSQL** database (local or remote — Supabase recommended)
- **systemd** (Linux only, for scheduler)
- One of the tracked tools installed (optional): Codex CLI, OpenCode CLI, or Hermes Agent

### Environment Variables

Create a `.env.local` file in the project root:

```env
# Database (PostgreSQL via Supabase or direct connection)
DATABASE_URL=postgresql://user:password@host:5432/dbname

# Next.js
NEXT_PUBLIC_SITE_URL=http://localhost:3000

# Optional: DevTrack API (defaults to http://localhost:3000)
DEVTRAK_API_URL=http://localhost:3000
```

If using Supabase, also configure the Supabase env vars if you use the Supabase client for auth:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
```

### Supabase Setup

1. Create a Supabase project at [supabase.com](https://supabase.com)
2. In the SQL Editor, run the Drizzle migrations to create the tables
3. Copy your project URL and anon key into `.env.local`

### Drizzle Database Setup

The project uses **Drizzle ORM** with PostgreSQL. Schema is defined in `src/lib/db/schema.ts`.

```bash
# Generate migration files
npm run db:generate

# Apply migrations to the database
npm run db:migrate

# (Optional) Seed demo data only. Do not run against production unless demo data is intended.
npm run db:seed

# (Optional) Open Drizzle Studio for inspecting data
npm run db:studio
```

The schema includes these tables:

- `workspaces` — Multi-tenant workspaces
- `quota_pools` — Quota pools with allocation, rollover policy
- `devices` — Registered devices (fingerprint-based)
- `tool_instances` — AI tool/agent registrations
- `tool_quota_attributions` — Links tools to pools with allocation amounts
- `usage_snapshots` — Immutable usage records with idempotency keys
- `usage_current_state` — Materialized current window states (fast-read)
- `agent_heartbeats` — Agent heartbeat log
- `bootstrap_tokens` — Device registration tokens
- `manual_usage_entries` — Manually entered usage records

### Build the Agent

```bash
npm install
npm run build
```

After building, the TypeScript CLI (`scripts/ega-devtrack.ts`) is compiled to `scripts/ega-devtrack.js` and ready to use directly or via npm scripts.

### Production Agent Setup

The dashboard cannot know local Codex/OpenCode/Hermes usage until a local agent is registered and uploads. Run these commands on the VM or local PC that has the tools/configs installed.

1. Generate a bootstrap token in the dashboard:

```text
https://ai-quota-pool-tracker.vercel.app/devices/add
```

2. Register the device. The bootstrap token is consumed once; the returned device token is saved locally at `~/.local/share/ega-devtrack/config.json`.

```bash
DEVTRAK_API_URL=https://ai-quota-pool-tracker.vercel.app \
  node scripts/ega-devtrack.js register --token <bootstrap-token>
```

3. Preview normalized data locally. This uploads nothing.

```bash
node scripts/ega-devtrack.js once --dry-run
```

4. Upload one real payload.

```bash
node scripts/ega-devtrack.js once --upload
```

5. Install Linux scheduler if wanted.

```bash
node scripts/ega-devtrack.js install
```

6. Verify dashboard.

```text
https://ai-quota-pool-tracker.vercel.app/dashboard
```

Expected behavior: demo seed rows remain visible only until real device/current-state data exists. Real `usage_current_state` rows update the quota pool display and the demo banner clears.

---

## CLI Commands

All commands are run from the project root. You can use either the compiled JS directly or the npm script shortcuts.

### once --dry-run

Collect data from all installed tools and print the normalized payload to stdout. **No data is uploaded.**

```bash
node scripts/ega-devtrack.js once --dry-run
# or
npm run agent:dry-run
```

Output is a JSON object with:
- `dryRun: true` — confirmation that nothing was uploaded
- `timestamp` — when the collection ran
- `payload` — the full normalized payload
- `collectors.run` / `collectors.failed` — collector counts
- `errors` — any collector errors (if any)

**Always exits 0**, even if collectors fail.

### once --upload

Collect data and upload to the server. Before collecting fresh data, retries any previously failed uploads from the spool (oldest first).

```bash
node scripts/ega-devtrack.js once --upload
# or
npm run agent:upload
```

**Flow:**
1. Retry spooled items → delete on success, increment retry count on failure
2. Collect fresh data from all collectors
3. Upload payload to `{DEVTRAK_API_URL}/api/ingest`
4. On failure: spool the payload to `~/.local/share/ega-devtrack/spool/` for later retry

**Required:** registered device token, from `ega-devtrack register --token <bootstrap-token>`. The upload sends `Authorization: Bearer <device-token>` to `POST /api/ingest`; token value is never printed.

`DEVTRAK_API_URL` defaults to saved registration endpoint, then `http://localhost:3000`.

### register

Register this local machine against the server using a short-lived bootstrap token from `/devices/add`.

```bash
DEVTRAK_API_URL=https://ai-quota-pool-tracker.vercel.app \
  node scripts/ega-devtrack.js register --token <bootstrap-token>
```

Options:
- `--endpoint <url>` overrides `DEVTRAK_API_URL`
- `--device-name <name>` sets the dashboard device label

The command saves only the device token and endpoint locally. It does not upload Codex/OpenCode/Hermes secrets.

### privacy-report

Print a detailed breakdown of what the agent uploads and what it never uploads. Run this to verify the data boundary before enabling scheduled uploads.

```bash
node scripts/ega-devtrack.js privacy-report
# or
npm run agent:privacy-report
```

### install (Linux)

Install a systemd user timer that runs `ega-devtrack once --upload` every 15 minutes.

```bash
node scripts/ega-devtrack.js install
# or
npm run agent:install
```

**What it does:**
1. Ensures systemd user mode is available (`systemctl --user`)
2. Creates data directory at `~/.local/share/ega-devtrack/`
3. Writes unit files:
   - `~/.config/systemd/user/ega-devtrack.service`
   - `~/.config/systemd/user/ega-devtrack.timer`
4. Runs `systemctl --user daemon-reload`
5. Enables and starts the timer: `systemctl --user enable --now ega-devtrack.timer`

**Note:** Run `ega-devtrack register --token <bootstrap-token>` before installing the scheduler.

### install (Windows)

Windows scheduler support is **not yet implemented**. The `install` command on Windows will fail. Status:

```bash
node scripts/ega-devtrack.js status
# → "Agent scheduler: NOT AVAILABLE (systemd user mode not found)"
```

For manual scheduling on Windows, use Task Scheduler to run:
```powershell
# Every 15 minutes, run:
node C:\path\to\project\scripts\ega-devtrack.js once --upload
```

Cross-platform support (Task Scheduler / launchd) is planned for a future release.

### uninstall

Remove the systemd scheduler units:

```bash
node scripts/ega-devtrack.js uninstall
# or
npm run agent:uninstall
```

**What it does:**
1. Stops and disables the timer
2. Removes `ega-devtrack.service` and `ega-devtrack.timer` from `~/.config/systemd/user/`
3. Reloads systemd daemon

**Does not delete** the data directory (`~/.local/share/ega-devtrack/`) — spool data is preserved.

### status

Show the current scheduler and spool status:

```bash
node scripts/ega-devtrack.js status
# or
npm run agent:status
```

**Output includes:**
- Unit file existence (service + timer paths)
- Data directory status
- Spool health:
  - Entry count
  - Total size (KB)
  - Oldest entry age
  - Health check (yellow flag if spool exceeds limits)
- Timer active / enabled state
- Last trigger time
- Next trigger time
- Last run result (exit code)

If the scheduler is not installed, prints a prompt to run `install`.

### npm Script Shortcuts

| Command                        | Equivalent                                              |
|--------------------------------|---------------------------------------------------------|
| `npm run agent:dry-run`        | `node scripts/ega-devtrack.js once --dry-run`           |
| `npm run agent:upload`         | `node scripts/ega-devtrack.js once --upload`            |
| `npm run agent:privacy-report` | `node scripts/ega-devtrack.js privacy-report`           |
| `npm run agent:help`           | `node scripts/ega-devtrack.js --help`                   |
| `npm run agent:install`        | `node scripts/ega-devtrack.js install`                  |
| `npm run agent:uninstall`      | `node scripts/ega-devtrack.js uninstall`                |
| `npm run agent:status`         | `node scripts/ega-devtrack.js status`                   |

---

## Troubleshooting

### Stale Device

A device becomes **stale** when the server hasn't received a heartbeat or upload from it within the expected interval (15 minutes with the timer).

**Symptoms:**
- Device shows "offline" on the devices page (`/devices`)
- Quota pool usage stops updating
- `ega-devtrack status` shows that uploads are failing

**Causes & fixes:**

| Cause | Check | Fix |
|-------|-------|-----|
| Timer not running | `systemctl --user status ega-devtrack.timer` | `ega-devtrack install` |
| Network down | Check internet connectivity | Restore connection |
| Server unreachable | `curl $DEVTRAK_API_URL` | Verify server is running |
| Spool full | `ega-devtrack status` → spool health | Clear spool: `rm -rf ~/.local/share/ega-devtrack/spool/*` |
| Token expired | Check `bootstrap_tokens` table | Generate a new bootstrap token |
| Agent not registered | Check device list at `/devices` | Add device at `/devices/add` |

**To re-register a stale device:**
1. Go to the dashboard → **Devices** → **Add Device**
2. Generate a new bootstrap token
3. Set the token as an env var or pass it to the agent
4. Run `ega-devtrack register --token <bootstrap-token>`
5. Run `ega-devtrack once --upload`

### Token Revoke / Rotate

If a device token is compromised, lost, or needs to be rotated:

1. **Revoke the old token** in the Supabase dashboard → `bootstrap_tokens` table → set `is_active = false` (or delete the row)
2. **Generate a new token** from the dashboard at `/devices/add`
3. Register with the new bootstrap token:
   ```bash
   node scripts/ega-devtrack.js register --token <bootstrap-token>
   ```
4. Test collection:
   ```bash
   node scripts/ega-devtrack.js once --dry-run
   ```
5. Run an upload:
   ```bash
   node scripts/ega-devtrack.js once --upload
   ```

### Windows Status / Uninstall

On Windows, the `status` command will report:
```
Agent scheduler: NOT AVAILABLE (systemd user mode not found)
```

The `uninstall` command on Windows will also exit with the same error since no systemd units are present. No cleanup is needed.

If you manually set up Task Scheduler entries:
1. Open **Task Scheduler**
2. Find the task (e.g. "ega-devtrack")
3. Right-click → **Disable** or **Delete**

### Linux Scheduler Logs

View agent output:
```bash
journalctl --user -u ega-devtrack.service
```

Follow logs in real time:
```bash
journalctl --user -u ega-devtrack.service -f
```

---

## Deferred Features

The following features are planned but **not yet implemented** in the MVP:

- **Token totals display** — aggregate usage across all pools and tools, summed per workspace/month
- **Working hours tracking** — time-of-day and day-of-week filtering for quota consumption
- **Windows scheduler** — automatic Task Scheduler integration
- **macOS scheduler** — launchd plist generation
- **OpenCode Go usage API** — provider detection works, but usage amount stays manual/unknown until an official machine-readable usage API is available

---

## Architecture Overview

```
┌─────────────────────┐        ┌──────────────────────┐
│   Codex CLI          │        │   OpenCode CLI       │
│   ~/.codex/config    │        │   opencode models    │
└────────┬────────────┘        └──────────┬───────────┘
         │                                │
         ▼                                ▼
┌──────────────────────────────────────────────────────┐
│              ega-devtrack Agent (CLI)                 │
│                                                      │
│  runAllCollectors() → sanitize() → IngestPayload     │
│                                                      │
│  Spool: ~/.local/share/ega-devtrack/spool/           │
│  Timer: systemd (every 15 min)                       │
└──────────────────────┬───────────────────────────────┘
                       │ POST /api/ingest
                       ▼
┌──────────────────────────────────────────────────────┐
│              Next.js Server (API)                     │
│                                                      │
│  Drizzle ORM → PostgreSQL (Supabase)                 │
│                                                      │
│  Tables: quota_pools, usage_snapshots, devices,      │
│          tool_instances, tool_quota_attributions     │
└──────────────────────┬───────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────┐
│              Web Dashboard (Next.js)                  │
│                                                      │
│  /dashboard     — Overview                           │
│  /devices/add   — Register device / generate token   │
│  /workspaces/:id/manual-usage/new — Manual entry     │
└──────────────────────────────────────────────────────┘
```
