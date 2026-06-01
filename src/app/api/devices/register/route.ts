import { NextRequest, NextResponse } from "next/server";
import { registerDevice } from "@/lib/devices";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { bootstrapToken, deviceName, os, agentVersion } = body;

    if (!bootstrapToken || typeof bootstrapToken !== "string") {
      return NextResponse.json(
        { error: "bootstrapToken is required" },
        { status: 400 },
      );
    }

    if (!deviceName || typeof deviceName !== "string") {
      return NextResponse.json(
        { error: "deviceName is required" },
        { status: 400 },
      );
    }

    const result = await registerDevice(
      bootstrapToken,
      deviceName,
      typeof os === "string" ? os : null,
      typeof agentVersion === "string" ? agentVersion : null,
    );

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Internal server error";

    let status = 400;
    if (message.includes("not found")) status = 404;
    else if (message.includes("expired")) status = 410;
    else if (message.includes("Invalid")) status = 401;

    return NextResponse.json({ error: message }, { status });
  }
}
