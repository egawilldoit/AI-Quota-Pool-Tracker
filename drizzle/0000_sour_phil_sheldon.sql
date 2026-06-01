CREATE TABLE "agent_heartbeats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_fingerprint" text NOT NULL,
	"tool_type" text NOT NULL,
	"device_fingerprint" text,
	"metadata" text,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bootstrap_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"label" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bootstrap_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"device_fingerprint" text NOT NULL,
	"label" text,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "manual_usage_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"quota_pool_id" uuid NOT NULL,
	"usage_amount" numeric(20, 6) NOT NULL,
	"description" text,
	"entered_by" text NOT NULL,
	"entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quota_pools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"account_fingerprint" text NOT NULL,
	"display_name" text NOT NULL,
	"total_allocated" numeric(20, 6) DEFAULT '0' NOT NULL,
	"rollover_policy" text DEFAULT 'none' NOT NULL,
	"rollover_cap" numeric(20, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"tool_type" text NOT NULL,
	"display_name" text,
	"agent_fingerprint" text,
	"metadata" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_quota_attributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tool_instance_id" uuid NOT NULL,
	"quota_pool_id" uuid NOT NULL,
	"allocated_amount" numeric(20, 6) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_current_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"quota_pool_id" uuid NOT NULL,
	"window_name" text NOT NULL,
	"usage_amount" numeric(20, 6) DEFAULT '0' NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"last_updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"quota_pool_id" uuid NOT NULL,
	"usage_amount" numeric(20, 6) NOT NULL,
	"snapshot_window_start" timestamp with time zone NOT NULL,
	"snapshot_window_end" timestamp with time zone NOT NULL,
	"idempotency_key" text NOT NULL,
	"source" text DEFAULT 'heartbeat' NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_snapshots_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "agent_heartbeats" ADD CONSTRAINT "agent_heartbeats_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bootstrap_tokens" ADD CONSTRAINT "bootstrap_tokens_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_usage_entries" ADD CONSTRAINT "manual_usage_entries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_usage_entries" ADD CONSTRAINT "manual_usage_entries_quota_pool_id_quota_pools_id_fk" FOREIGN KEY ("quota_pool_id") REFERENCES "public"."quota_pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_pools" ADD CONSTRAINT "quota_pools_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_instances" ADD CONSTRAINT "tool_instances_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_quota_attributions" ADD CONSTRAINT "tool_quota_attributions_tool_instance_id_tool_instances_id_fk" FOREIGN KEY ("tool_instance_id") REFERENCES "public"."tool_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_quota_attributions" ADD CONSTRAINT "tool_quota_attributions_quota_pool_id_quota_pools_id_fk" FOREIGN KEY ("quota_pool_id") REFERENCES "public"."quota_pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_current_state" ADD CONSTRAINT "usage_current_state_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_current_state" ADD CONSTRAINT "usage_current_state_quota_pool_id_quota_pools_id_fk" FOREIGN KEY ("quota_pool_id") REFERENCES "public"."quota_pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_snapshots" ADD CONSTRAINT "usage_snapshots_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_snapshots" ADD CONSTRAINT "usage_snapshots_quota_pool_id_quota_pools_id_fk" FOREIGN KEY ("quota_pool_id") REFERENCES "public"."quota_pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_quota_pool_workspace_kind_fingerprint" ON "quota_pools" USING btree ("workspace_id","kind","account_fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_tool_quota_attribution" ON "tool_quota_attributions" USING btree ("tool_instance_id","quota_pool_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_current_state" ON "usage_current_state" USING btree ("workspace_id","quota_pool_id","window_name");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_snapshot_idempotency" ON "usage_snapshots" USING btree ("idempotency_key");