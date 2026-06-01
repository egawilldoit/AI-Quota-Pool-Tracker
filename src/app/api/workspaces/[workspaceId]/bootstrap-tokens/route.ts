import { NextRequest, NextResponse } from "next/server";
import { generateBootstrapToken } from "@/lib/devices";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const { workspaceId } = await params;
    const body = await _request.json();
    const label = typeof body?.label === "string" ? body.label : undefined;

    const result = await generateBootstrapToken(workspaceId, label);
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Internal server error";
    const status = message.includes("not found") ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
