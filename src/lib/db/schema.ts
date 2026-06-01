import {
  pgTable,
  text,
  timestamp,
  numeric,
  uuid,
  uniqueIndex,
  boolean,
} from "drizzle-orm/pg-core";

// ── Workspaces ────────────────────────────────────────────────
export const workspaces = pgTable("workspaces", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

// ── Quota Pools ───────────────────────────────────────────────
export const quotaPools = pgTable(
  "quota_pools",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    kind: text("kind").notNull(), // e.g. "credits", "tokens", "api_calls"
    accountFingerprint: text("account_fingerprint").notNull(),
    displayName: text("display_name").notNull(),
    totalAllocated: numeric("total_allocated", { precision: 20, scale: 6 })
      .default("0")
      .notNull(),
    rolloverPolicy: text("rollover_policy").default("none").notNull(), // none, full, capped
    rolloverCap: numeric("rollover_cap", { precision: 20, scale: 6 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uq_quota_pool_workspace_kind_fingerprint").on(
      table.workspaceId,
      table.kind,
      table.accountFingerprint,
    ),
  ],
);

// ── Devices ───────────────────────────────────────────────────
export const devices = pgTable("devices", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id")
    .references(() => workspaces.id, { onDelete: "cascade" })
    .notNull(),
  deviceFingerprint: text("device_fingerprint").notNull(),
  label: text("label"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

// ── Tool Instances ────────────────────────────────────────────
export const toolInstances = pgTable("tool_instances", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id")
    .references(() => workspaces.id, { onDelete: "cascade" })
    .notNull(),
  toolType: text("tool_type").notNull(), // e.g. "claude-code", "github-copilot", "codex"
  displayName: text("display_name"),
  agentFingerprint: text("agent_fingerprint"),
  metadata: text("metadata"), // JSON blob for extensible config
  isActive: boolean("is_active").default(true).notNull(),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

// ── Tool Quota Attributions ───────────────────────────────────
// Links a tool instance to a quota pool and tracks how much it has been allocated.
export const toolQuotaAttributions = pgTable(
  "tool_quota_attributions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    toolInstanceId: uuid("tool_instance_id")
      .references(() => toolInstances.id, { onDelete: "cascade" })
      .notNull(),
    quotaPoolId: uuid("quota_pool_id")
      .references(() => quotaPools.id, { onDelete: "cascade" })
      .notNull(),
    allocatedAmount: numeric("allocated_amount", { precision: 20, scale: 6 })
      .default("0")
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uq_tool_quota_attribution").on(
      table.toolInstanceId,
      table.quotaPoolId,
    ),
  ],
);

// ── Usage Snapshots ───────────────────────────────────────────
export const usageSnapshots = pgTable(
  "usage_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    quotaPoolId: uuid("quota_pool_id")
      .references(() => quotaPools.id, { onDelete: "cascade" })
      .notNull(),
    usageAmount: numeric("usage_amount", { precision: 20, scale: 6 })
      .notNull(),
    snapshotWindowStart: timestamp("snapshot_window_start", {
      withTimezone: true,
    }).notNull(),
    snapshotWindowEnd: timestamp("snapshot_window_end", {
      withTimezone: true,
    }).notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    source: text("source").default("heartbeat").notNull(), // heartbeat, manual, import
    capturedAt: timestamp("captured_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("uq_usage_snapshot_idempotency").on(table.idempotencyKey),
  ],
);

// ── Usage Current State ──────────────────────────────────────
// Fast-read materialized window that is upserted frequently.
export const usageCurrentState = pgTable(
  "usage_current_state",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    quotaPoolId: uuid("quota_pool_id")
      .references(() => quotaPools.id, { onDelete: "cascade" })
      .notNull(),
    windowName: text("window_name").notNull(), // e.g. "2026-06-01-weekly", "2026-06-hourly"
    usageAmount: numeric("usage_amount", { precision: 20, scale: 6 })
      .default("0")
      .notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    lastUpdatedAt: timestamp("last_updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("uq_usage_current_state").on(
      table.workspaceId,
      table.quotaPoolId,
      table.windowName,
    ),
  ],
);

// ── Agent Heartbeats ──────────────────────────────────────────
export const agentHeartbeats = pgTable("agent_heartbeats", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id")
    .references(() => workspaces.id, { onDelete: "cascade" })
    .notNull(),
  agentFingerprint: text("agent_fingerprint").notNull(),
  toolType: text("tool_type").notNull(),
  deviceFingerprint: text("device_fingerprint"),
  metadata: text("metadata"),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// ── Bootstrap Tokens ──────────────────────────────────────────
export const bootstrapTokens = pgTable("bootstrap_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id")
    .references(() => workspaces.id, { onDelete: "cascade" })
    .notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  label: text("label"),
  isActive: boolean("is_active").default(true).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// ── Manual Usage Entries ──────────────────────────────────────
export const manualUsageEntries = pgTable("manual_usage_entries", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id")
    .references(() => workspaces.id, { onDelete: "cascade" })
    .notNull(),
  quotaPoolId: uuid("quota_pool_id")
    .references(() => quotaPools.id, { onDelete: "cascade" })
    .notNull(),
  usageAmount: numeric("usage_amount", { precision: 20, scale: 6 }).notNull(),
  description: text("description"),
  enteredBy: text("entered_by").notNull(),
  enteredAt: timestamp("entered_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
