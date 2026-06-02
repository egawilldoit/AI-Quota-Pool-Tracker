# AI Quota Pool Tracker — DevTrack Agent

> **Status:** MVP · Agent: `ega-devtrack` (CLI)  
> **Repository:** https://github.com/egawilldoit/AI-Quota-Pool-Tracker

---

## Table of Contents

1. [What Is a Quota Pool?](#what-is-a-quota-pool)
2. [How Tools Are Tracked](#how-tools-are-tracked)
   - [Collection Levels](#collection-levels)
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
   - [usage collect](#usage-collect)
   - [opencode-go manual](#opencode-go-manual)
   - [privacy-report](#privacy-report)
   - [install / uninstall / status](#install-uninstall-status)
6. [Dashboard](#dashboard)
   - [Multi-Window Display](#multi-window-display)
   - [Source Labels](#source-labels)
   - [Stale Warnings](#stale-warnings)
7. [Troubleshooting](#troubleshooting)
   - [Stale Device](#stale-device)
   - [Token Revoke / Rotate](#token-revoke--rotate)
   - [Known Limitations](#known-limitations)

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

---

## How Tools Are Tracked

### Collection Levels

The DevTrack agent operates at three collection levels, in priority order:

| Level | Name | Description | Default |
|-------|------|-------------|---------|
| 1 | **Safe detection** | Reads only safe files (config.toml, opencode models output, config.yaml). Emits detection windows with usage = unknown (-1). | **Always enabled** |
| 2 | **Manual entry** | User enters usage values via CLI commands or dashboard forms. | **On-demand** |
| 3 | **Experimental browser** | Reads usage from local browser dashboard (Codex Analytics, OpenCode Go workspace). Opt-in only. | **Disabled by default** |

The dashboard shows **"Usage unknown — run collector or enter manual usage"** when usage is unknown. It never displays fake 0%.

### Codex / ChatGPT

#### Level 1 — Safe detection (always runs)
- Reads `~/.codex/config.toml` → model name only
- Classifies: `gpt-*`, `o1`, `o3`, `o4` → high-confidence paid (0.9)
- Emits 3 detection windows: `codex-5h`, `codex-weekly`, `codex-credits`
- All with `usageAmount=-1` (unknown), source: `detected`

#### Level 2 — CLI status (runs when TTY available)
- `codex status` (via PTY wrapper) → parses multi-window output
- Converts remaining-to-used: 54% remaining → 46% used
- Windows: 5h, weekly, credits
- Source: `codex_cli_status`, confidence: 0.85
- **Limitation:** `codex status` requires TTY — won't work in cron/scheduler mode

#### Level 3 — Experimental browser dashboard (opt-in)
```bash
DEVTRACK_EXPERIMENTAL_CODEX_BROWSER_USAGE=1
```
- Uses Playwright to read visible text from Codex Analytics dashboard
- Extracts: 5h remaining%, weekly remaining%, credits remaining
- Source: `codex_browser_dashboard`, confidence: 0.95
- **NEVER uploads cookies, auth tokens, or raw HTML**
- Requires: `npm install playwright && npx playwright install chromium`

### OpenCode Go

#### Level 1 — Safe detection (always runs)
- `opencode models` → detects provider prefix
- `opencode-go/` → OpenCode Go pool (confidence 0.8)
- Emits 3 detection windows: `opencode-go-rolling`, `opencode-go-weekly`, `opencode-go-monthly`
- All with `usageAmount=-1` (unknown), source: `detected`

#### Level 2 — Manual entry (CLI)
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
- Source: `manual_opencode_go`, confidence: 0.95
- Reset hints optional — used to compute window end times

#### Level 3 — Experimental browser dashboard (opt-in)
```bash
DEVTRACK_EXPERIMENTAL_OPENCODE_GO_BROWSER_USAGE=1
DEVTRACK_OPENCODE_GO_WORKSPACE_ID=wrk_...
```
- Targets: `https://opencode.ai/workspace/<workspaceId>/go`
- Extracts: Rolling Usage %, Weekly Usage %, Monthly Usage %, reset hints
- Source: `opencode_go_browser_dashboard`, confidence: 0.95
- Optional local config: `~/.local/share/ega-devtrack/opencode-go.json`
  ```json
  { "workspaceId": "wrk_...", "browserCollectorEnabled": true }
  ```

#### Why OpenCode Go automatic usage is limited
OpenCode Go's workspace dashboard shows usage percentages visually (Rolling/Weekly/Monthly), but there is no documented stable public API for programmatic access. OpenCode issue #16017 requests this feature. Until a stable API exists, the browser collector path is experimental and the manual CLI path is the recommended way to enter accurate usage.

#### Why Codex cron cannot rely on TTY /status
`codex status` requires an interactive terminal (TTY/PTY). The cron scheduler runs as a systemd service without a TTY, so the status command fails with "stdin is not a terminal." The scheduler falls back to detection mode (Level 1), and accurate usage collection requires either a manual `codex status` run from a terminal or the experimental browser collector.

### Hermes Agent

Reads `~/.hermes/config.yaml` to determine the active provider and model.

- **Provider classification:**
  - `provider: opencode-go` → OpenCode Go pool (confidence 0.8)
  - `provider: openai` → OpenAI Provider pool (confidence 0.7)
  - `provider: openrouter` with model `openai/` → OpenAI Provider
  - Model `:free` → Free pool (confidence 0.5)
- Usage attributed to matching pool. Unknown unless upstream exposes safe usage data.

### Manual Usage Fallback

1. **For OpenCode Go:** `ega-devtrack opencode-go manual` CLI (see above)
2. **For any pool:** Dashboard → pool card → "Record Manual Usage" button
3. Or navigate to `/workspaces/[workspaceId]/manual-usage/new`

---

## Privacy & Data Boundary

### What the Agent Uploads

Normalized metadata only:
- Device fingerprint (hashed), agent version, OS platform
- Quota pool UUID, window name, usage amount (%), window boundaries
- Source label, confidence score (0–1)
- Tool type, display name, model name
- Detection status (installed/detected or not)

**Browser collector uploads ONLY:** normalized percentages and reset times. Never: cookies, auth tokens, full HTML, browser state, or any dashboard data beyond usage numbers.

### What the Agent NEVER Uploads

API keys/tokens, prompts/completions, source code, cookies, auth files, shell history, personal data, private keys, raw config files, device hostname (raw), network info, browser cookies, Codex auth tokens, OpenCode Zen keys, Hermes .env secrets.

### How Data Is Sanitized

All collected data passes through `sanitize()` which redacts: `sk-*`, `tok_*`, `ghp_*`, `gho_*`, `xox[bpar]-`, `AKIA*`, Slack tokens, and property names: `apiKey`, `api_key`, `token`, `authorization`, `password`, `bearer`, `auth`.

---

## CLI Commands

### once --dry-run / --upload

```bash
npm run agent:dry-run     # Preview only, no upload
npm run agent:upload      # Collect + upload + retry spool
```

### usage collect

Collect usage from all safe + experimental collectors and display a summary:

```bash
# Preview with experimental collectors
DEVTRACK_EXPERIMENTAL_CODEX_BROWSER_USAGE=1 \
  node scripts/ega-devtrack.js usage collect --dry-run

# Upload with experimental collectors
DEVTRACK_EXPERIMENTAL_CODEX_BROWSER_USAGE=1 \
  node scripts/ega-devtrack.js usage collect --upload
```

Output example:
```
  === Usage Summary ===
  Codex:
    5h: 46% used (source: codex_cli_status, confidence: 0.85)
    weekly: 24% used (source: codex_cli_status, confidence: 0.85)
    credits: 0% used (source: codex_cli_status, confidence: 0.85)
  OpenCode Go:
    rolling: unknown (source: detected)
    weekly: unknown (source: detected)
    monthly: unknown (source: detected)
```

### opencode-go manual

```bash
DEVTRAK_API_URL=https://ai-quota-pool-tracker.vercel.app \
  node scripts/ega-devtrack.js opencode-go manual \
    --rolling-used-pct N --weekly-used-pct N --monthly-used-pct N \
    [--rolling-reset "57 minutes"] \
    [--weekly-reset "5 days 11 hours"] \
    [--monthly-reset "26 days 8 hours"]
```

### privacy-report

```bash
npm run agent:privacy-report
```

### install / uninstall / status

```bash
npm run agent:install
npm run agent:uninstall
npm run agent:status
```

---

## Dashboard

### Multi-Window Display

Each pool card now shows all usage windows (one per `window_name`):
- **Codex:** 5h, weekly, credits
- **OpenCode Go:** rolling, weekly, monthly

Each window shows:
- Usage percentage (or "Unknown" if data unavailable)
- Source badge (CLI, Browser, Manual, Detected)
- Confidence level (High/Med/Low)
- Last updated time with stale indicator

### Source Labels

| Dashboard Label | Source Value | Meaning |
|-----------------|-------------|---------|
| CLI | `codex_cli_status`, `codex-status` | From `codex status` command |
| Browser | `codex_browser_dashboard`, `opencode_go_browser_dashboard` | From experimental browser collector |
| Manual | `manual_opencode_go`, `manual` | User-entered via CLI or form |
| Detected | `detected`, `heartbeat` | Tool detected but usage unknown |

### Stale Warnings

A window is marked **Stale** when its `lastUpdatedAt` is older than 30 minutes. The dashboard shows a yellow "Stale" badge and the time since last update.

---

## Troubleshooting

### Stale Device

A device becomes stale when no heartbeat/upload within 15 minutes. Dashboard shows "offline" on devices page.

### Known Limitations

| Issue | Status |
|-------|--------|
| Codex status requires TTY — won't run in cron | Use experimental browser collector or manual entry |
| OpenCode Go has no public usage API | Use manual CLI or experimental browser collector |
| Playwright not bundled — manual install needed | `npm install playwright && npx playwright install chromium` |
| Windows Task Scheduler not yet supported | Cross-platform planned |
| Browser collectors are experimental skeletons | Full Playwright integration pending; manual CLI available now |
