import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { quotaPools, usageCurrentState, workspaces } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const wsList = await db
      .select({ id: workspaces.id, name: workspaces.name, slug: workspaces.slug })
      .from(workspaces)
      .orderBy(workspaces.name);

    const workspacesWithSeedFlag = await Promise.all(
      wsList.map(async (workspace) => ({
        ...workspace,
        isDemoSeed: await isDemoSeedWorkspace(workspace.id),
      })),
    );

    return NextResponse.json({ workspaces: workspacesWithSeedFlag });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function isDemoSeedWorkspace(workspaceId: string): Promise<boolean> {
  const [seedRow] = await db
    .select({ id: quotaPools.id })
    .from(quotaPools)
    .innerJoin(usageCurrentState, eq(usageCurrentState.quotaPoolId, quotaPools.id))
    .where(
      and(
        eq(quotaPools.workspaceId, workspaceId),
        eq(quotaPools.accountFingerprint, "openai-codex-chatgpt-credits"),
        eq(quotaPools.displayName, "Codex & ChatGPT"),
        eq(quotaPools.totalAllocated, "1000"),
        eq(usageCurrentState.usageAmount, "650"),
      ),
    )
    .limit(1);

  return Boolean(seedRow);
}
