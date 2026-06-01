import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { workspaces } from "@/lib/db/schema";

export async function GET() {
  try {
    const wsList = await db
      .select({ id: workspaces.id, name: workspaces.name, slug: workspaces.slug })
      .from(workspaces)
      .orderBy(workspaces.name);

    return NextResponse.json({ workspaces: wsList });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
