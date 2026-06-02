import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { quotaPools, usageCurrentState } from "@/lib/db/schema";
import { validateDeviceToken } from "@/lib/devices";
import { isLegacyWindowName } from "@/lib/usage-windows";
import { and, eq, inArray } from "drizzle-orm";

export const dynamic = "force-dynamic";

const cleanupSchema = z.object({
  apply: z.boolean().default(false),
});

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Missing or invalid Authorization header" }, { status: 401 });
  }

  const device = await validateDeviceToken(authHeader.slice("Bearer ".length).trim());
  if (!device) {
    return NextResponse.json({ error: "Invalid device token" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = cleanupSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const rows = await db
    .select({
      id: usageCurrentState.id,
      windowName: usageCurrentState.windowName,
      poolName: quotaPools.displayName,
    })
    .from(usageCurrentState)
    .innerJoin(quotaPools, eq(quotaPools.id, usageCurrentState.quotaPoolId))
    .where(eq(usageCurrentState.workspaceId, device.workspaceId));

  const staleRows = rows.filter((row) => isLegacyWindowName(row.windowName));
  const ids = staleRows.map((row) => row.id);
  let deletedCount = 0;

  if (parsed.data.apply && ids.length > 0) {
    await db
      .delete(usageCurrentState)
      .where(
        and(
          eq(usageCurrentState.workspaceId, device.workspaceId),
          inArray(usageCurrentState.id, ids),
        ),
      );
    deletedCount = ids.length;
  }

  return NextResponse.json({
    applied: parsed.data.apply,
    staleWindowCount: staleRows.length,
    deletedCount,
    windowNames: [...new Set(staleRows.map((row) => row.windowName))].sort(),
  });
}
