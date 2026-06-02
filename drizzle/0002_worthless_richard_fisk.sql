ALTER TABLE "usage_snapshots" ADD COLUMN "window_name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_snapshots" ADD COLUMN "confidence" numeric(4, 3) DEFAULT '1.0' NOT NULL;