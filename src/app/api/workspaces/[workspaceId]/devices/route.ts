import { NextRequest, NextResponse } from "next/server";
import { getDevicesWithHealth } from "@/lib/devices";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const { workspaceId } = await params;
    const devicesList = await getDevicesWithHealth(workspaceId);
    return NextResponse.json({ devices: devicesList });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
