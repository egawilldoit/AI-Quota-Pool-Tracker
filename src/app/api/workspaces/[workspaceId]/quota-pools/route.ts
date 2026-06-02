import { NextRequest, NextResponse } from "next/server";
import { getQuotaPoolsForWorkspace } from "@/lib/quota-pools";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const { workspaceId } = await params;
    const data = await getQuotaPoolsForWorkspace(workspaceId);
    return NextResponse.json(data);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Internal server error";
    const status = message.includes("not found") ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
