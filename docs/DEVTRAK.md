# AI Quota Pool Tracker — DevTrack Agent

> **Status:** MVP · Agent: `ega-devtrack` (CLI)  
> **Repository:** https://github.com/egawilldoit/AI-Quota-Pool-Tracker

---

## Table of Contents

1. [What Is a Quota Pool?](#what-is-a-quota-pool)
2. [How Tools Are Tracked](#how-tools-are-tracked)
   - [Detection vs. Usage Tracking](#detection-vs-usage-tracking)
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
   - [opencode-go manual](#opencode-go-manual)
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

A **quota pool** is a virtual bucket that tracks consumption of AI credits across tools and time windows. Each pool belongs to a workspace and is identified by a unique UUID. Pools track usage in **named windows** — for example `codex-5h`, `opencode-go-weekly` — and record the amount consumed, the time boundaries, and a confidence score for the measurement.

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

### Detection vs. Usage Tracking

The DevTrack agent operates at two levels:

1. **Detection** — determines whether a tool is installed and which provider/model it uses. Detection runs automatically on every collector pass. The dashboard shows which tools are detected, but usage data is marked as "unknown" until real usage data arrives.

2. **Usage tracking** — collects real usage percentages from the tool's own status/dashboard. Usage tracking requires the tool to expose a machine-readable status endpoint, or the user to enter values manually.

When usage is unknown, the dashboard displays **"Usage unknown — run collector or enter manual usage"** instead of showing fake 0%.

### Codex / ChatGPT

The agent detects Codex CLI by reading `~/.codex/config.toml` — specifically the top-level `model = "..."` field (e.g. `gpt-5.5`).

#### Collection paths (in priority order):

**A. Safe CLI path (`codex status`):**
- Runs `codex status` via PTY to collect real usage windows
- Parses multi-window output:
  - 5 hour usage limit: `54% remaining` → **46% used**
  - weekly usage limit: `76% remaining` → **24% used**
  - credits remaining: `0 of 1000` → **0% used**
- Source: `codex_cli_status`, confidence: `0.85`

**B. Detection fallback:**
- When `codex status` cannot run non-interactively (scheduled/cron mode)
- Emits detection windows (5h, weekly, credits) with usage = unknown (-1)
- Source: `detected`, confidence: model-based (0.7–0.9)
- Dashboard shows "Usage unknown" message, not fake 0%

**C. Experimental dashboard path (not yet implemented):**
- Gated by env flag: `DEVTRACK_EXPERIMENTAL_CODEX_DASHBOARD=1`
- Requires explicit user opt-in
- Would scrape Codex Analytics page if auth is configured
- Never enabled by default

- **Model classification:** Models starting with `gpt-`, `o1`, `o3`, or `o4` are classified as **high-confidence paid** (confidence 0.9) and mapped to the **Codex-ChatGPT** pool.
- **Privacy:** Only the model name is read. The agent **never** reads or uploads `~/.codex/auth.json` (contains tokens).
- If Codex is not installed or config is missing, the agent records a `detected: false` ToolInfo and produces no snapshots.

### OpenCode Go

The agent runs `opencode models` as a subprocess and parses the model list to detect the active provider. Usage collection currently requires manual entry.

#### Collection paths:

**A. Provider detection (automatic):**
- `opencode models` → classifies by provider prefix
  - Models prefixed `opencode-go/` → **OpenCode Go** pool (confidence 0.8)
  - Models prefixed `openai/` → **OpenAI Provider** pool (confidence 0.7)
  - Models prefixed `opencode/` → **Free** pool (confidence 0.5)
- Emits detection windows (rolling, weekly, monthly) with usage = unknown (-1)

**B. Manual entry (CLI):**
- Enter usage values from the OpenCode Go workspace page
- Command: `ega-devtrack opencode-go manual --rolling-used-pct N --weekly-used-pct N --monthly-used-pct N [--rolling-reset TEXT] [--weekly-reset TEXT] [--monthly-reset TEXT]`
- Source: `manual_opencode_go`, confidence: `0.95`
- Uploads directly to the server (no dry-run mode for manual entry)

**C. Experimental browser path (not yet implemented):**
- Gated by env flag: `DEVTRACK_EXPERIMENTAL_OPENCODE_GO_USAGE=1`
- Requires workspace ID: `DEVTRACK_OPENCODE_WORKSPACE_ID=wrk_...`
- Never enabled by default

**OpenCode Go limitations:**
- No official machine-readable usage API exists from OpenCode Go
- `opencode models` does not expose usage data — only model/provider info
- Manual entry is the primary path for accurate usage tracking
- The [OpenCode Go workspace page](https://opencode.ai) shows usage visually but has no stable API

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

When the agent cannot reliably detect usage for a specific tool or provider:

1. **For OpenCode Go:** Use `ega-devtrack opencode-go manual` CLI command (see above)
2. **For other tools:** Navigate to **Dashboard** → select a workspace → **Manual Usage**
3. URL pattern: `/workspaces/[workspaceId]/manual-usage/new`
4. Enter the usage amount, select the quota pool, and optionally add a description.

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
| `quotaPoolSnapshots[].windowName`            | Usage window label (e.g. `codex-5h`, `opencode-go-weekly`) |
| `quotaPoolSnapshots[].usageAmount`           | Numeric usage amount (-1 = unknown)                   |
| `quotaPoolSnapshots[].windowStart`           | ISO-8601 start of usage window                        |
| `quotaPoolSnapshots[].windowEnd`             | ISO-8601 end of usage window                          |
| `quotaPoolSnapshots[].idempotencyKey`        | Deduplication key                                     |
| `quotaPoolSnapshots[].source`                | Source label (`codex_cli_status`, `detected`, `manual_opencode_go`, `heartbeat`, `manual`, `import`) |
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
| Browser cookies     | No browser cookies or session data ever uploaded                  |
| API keys from tools | No Codex auth tokens, OpenCode Zen keys, or Hermes .env secrets   |

### How Data Is Sanitized

All collected data passes through a `sanitize()` function before being returned by any collector or written to the spool. This function:

- Redacts anything that looks like an API key or token (`sk-*`, `tok_*`, `ghp_*`, etc.)
- Redacts property names like `apiKey`, `token`, `authorization`, `password`, `bearer`, `auth`
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
DATABASE_URL=postgresql://user:***@host:5432/dbname

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
- `usage_current_state` — Materialized current window states (fast-read), keyed by `workspace_id + quota_pool_id + window_name`
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

2. Register the device:

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

5. (Optional) Enter OpenCode Go usage from screenshot:

```bash
DEVTRAK_API_URL=https://ai-quota-pool-tracker.vercel.app \
  node scripts/ega-devtrack.js opencode-go manual \
    --rolling-used-pct 3 \
    --weekly-used-pct 5 \
    --monthly-used-pct 14 \
    --rolling-reset "57 minutes" \
    --weekly-reset "5 days 11 hours" \
    --monthly-reset "26 days 8 hours"
```

6. Install Linux scheduler if wanted.

```bash
node scripts/ega-devtrack.js install
```

7. Verify dashboard.

```text
https://ai-quota-pool-tracker.vercel.app/dashboard
```

---

## CLI Commands

All commands are run from the project root.

### once --dry-run

```bash
node scripts/ega-devtrack.js once --dry-run
# or
npm run agent:dry-run
```

### once --upload

```bash
node scripts/ega-devtrack.js once --upload
# or
npm run agent:upload
```

### opencode-go manual

Enter OpenCode Go usage from the workspace dashboard values:

```bash
DEVTRAK_API_URL=https://ai-quota-pool-tracker.vercel.app \
  node scripts/ega-devtrack.js opencode-go manual \
    --rolling-used-pct N \
    --weekly-used-pct N \
    --monthly-used-pct N \
    [--rolling-reset "57 minutes"] \
    [--weekly-reset "5 days 11 hours"] \
    [--monthly-reset "26 days 8 hours"]
```

- `--rolling-used-pct`, `--weekly-used-pct`, `--monthly-used-pct` are **required**
- Reset hints are optional and used to compute window end times
- Source: `manual_opencode_go`, confidence: `0.95`
- Uploads directly — no dry-run mode

### privacy-report

```bash
node scripts/ega-devtrack.js privacy-report
# or
npm run agent:privacy-report
```

### install (Linux)

```bash
node scripts/ega-devtrack.js install
# or
npm run agent:install
```

### uninstall

```bash
node scripts/ega-devtrack.js uninstall
# or
npm run agent:uninstall
```

### status

```bash
node scripts/ega-devtrack.js status
# or
npm run agent:status
```

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
- Dashboard shows "Usage unknown" for all pools

### Token Revoke / Rotate

To rotate a device token: re-register the device. The old token is invalidated and a new one is generated.

### Deferred Features

- Windows Task Scheduler support (`ega-devtrack install` on Windows)
- Experimental Codex Analytics dashboard scraping (`DEVTRACK_EXPERIMENTAL_CODEX_DASHBOARD=1`)
- Experimental OpenCode Go workspace scraping (`DEVTRACK_EXPERIMENTAL_OPENCODE_GO_USAGE=1`)
- Automated OpenCode Go usage collection (blocked on stable usage API from OpenCode Go)
