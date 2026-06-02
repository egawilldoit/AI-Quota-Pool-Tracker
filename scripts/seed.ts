// Use process.env directly seeded by dotenv preload
// This is loaded via --require dotenv/config --env-file .env.local
import { db } from "../src/lib/db/client";
import { workspaces, quotaPools, usageCurrentState } from "../src/lib/db/schema";
import { eq } from "drizzle-orm";

async function seed() {
  console.log("🌱 Seeding demo quota pool data...");

  // ── Upsert default workspace ──────────────────────────────────
  let [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.slug, "default"))
    .limit(1);

  if (!workspace) {
    [workspace] = await db
      .insert(workspaces)
      .values({
        name: "Default Workspace",
        slug: "default",
        description: "Auto-created default workspace for quota pool tracking",
      })
      .returning();
    console.log(`  ✅ Created workspace: ${workspace.name} (${workspace.id})`);
  } else {
    console.log(`  ℹ️  Using existing workspace: ${workspace.name} (${workspace.id})`);
  }

  // ═══════════════════════════════════════════════════════════════
  // 1. Codex & ChatGPT Pool (credits, with usage data)
  // ═══════════════════════════════════════════════════════════════
  const codexFingerprint = "openai-codex-chatgpt-credits";

  let [codexPool] = await db
    .select()
    .from(quotaPools)
    .where(
      eq(quotaPools.accountFingerprint, codexFingerprint),
    )
    .limit(1);

  if (!codexPool) {
    [codexPool] = await db
      .insert(quotaPools)
      .values({
        workspaceId: workspace.id,
        kind: "credits",
        accountFingerprint: codexFingerprint,
        displayName: "Codex & ChatGPT",
        totalAllocated: "1000",
        rolloverPolicy: "none",
      })
      .returning();
    console.log(`  ✅ Created pool: ${codexPool.displayName} (${codexPool.id})`);
  } else {
    console.log(`  ℹ️  Using existing pool: ${codexPool.displayName} (${codexPool.id})`);
  }

  // Insert/update usage current state for Codex pool
  const now = new Date();
  const dayOfWeek = now.getDay();
  const windowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek);
  const windowEnd = new Date(windowStart);
  windowEnd.setDate(windowEnd.getDate() + 7);

  const windowName = `${windowStart.toISOString().slice(0, 10)}-weekly`;

  // Upsert: delete existing then insert
  await db
    .delete(usageCurrentState)
    .where(
      eq(usageCurrentState.quotaPoolId, codexPool.id),
    );

  await db
    .insert(usageCurrentState)
    .values({
      workspaceId: workspace.id,
      quotaPoolId: codexPool.id,
      windowName,
      usageAmount: "650", // 65% used
      windowStart,
      windowEnd,
    });
  console.log(`  ✅ Seeded usage state: 650 / 1000 (65%) for Codex & ChatGPT`);

  // ═══════════════════════════════════════════════════════════════
  // 2. OpenCode Go Pool (tokens, no usage data — unknown)
  // ═══════════════════════════════════════════════════════════════
  const opencodeFingerprint = "opencode-go-tokens";

  let [opencodePool] = await db
    .select()
    .from(quotaPools)
    .where(
      eq(quotaPools.accountFingerprint, opencodeFingerprint),
    )
    .limit(1);

  if (!opencodePool) {
    [opencodePool] = await db
      .insert(quotaPools)
      .values({
        workspaceId: workspace.id,
        kind: "tokens",
        accountFingerprint: opencodeFingerprint,
        displayName: "OpenCode Go",
        totalAllocated: "5000000",
        rolloverPolicy: "full",
      })
      .returning();
    console.log(`  ✅ Created pool: ${opencodePool.displayName} (${opencodePool.id})`);
  } else {
    console.log(`  ℹ️  Using existing pool: ${opencodePool.displayName} (${opencodePool.id})`);
  }
  // No usage state inserted — remains "unknown"

  console.log("\n✨ Demo seeding complete. Do not run against production unless demo data is intended.");
  process.exit(0);
}

seed().catch((err) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});
