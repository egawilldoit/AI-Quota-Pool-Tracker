ALTER TABLE "devices" ADD COLUMN "os" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "agent_version" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "token_hash" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_device_workspace_fingerprint" ON "devices" USING btree ("workspace_id","device_fingerprint");--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_token_hash_unique" UNIQUE("token_hash");