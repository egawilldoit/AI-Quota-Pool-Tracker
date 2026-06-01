import { NextRequest, NextResponse } from "next/server";
import { getDevicesForWorkspace } from "@/lib/devices";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const { workspaceId } = await params;
    const devicesList = await getDevicesForWorkspace(workspaceId);
    return NextResponse.json({ devices: devicesList });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
