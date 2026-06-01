import crypto from "node:crypto";
import { db } from "./db/client";
import {
  devices,
  bootstrapTokens,
  workspaces,
} from "./db/schema";
import { eq, and } from "drizzle-orm";
import { getEnv } from "./env";
import { createHash } from "node:crypto";

// ── Constants ──────────────────────────────────────────────────

const BOOTSTRAP_TOKEN_EXPIRY_MINUTES = 15;
const DEVICE_TOKEN_BYTES = 32;

// ── Types ──────────────────────────────────────────────────────

export type DeviceInfo = {
  id: string;
  workspaceId: string;
  label: string | null;
  os: string | null;
  agentVersion: string | null;
  deviceFingerprint: string;
  lastSeenAt: Date | null;
  createdAt: Date;
};

export type BootstrapTokenResult = {
  token: string;
  expiresAt: Date;
  installCommand: string;
};

export type DeviceRegistrationResult = {
  device: DeviceInfo;
  deviceToken: string;
};

// ── Helpers ────────────────────────────────────────────────────

function sha256Pepper(value: string): string {
  const pepper = getEnv().DEVTRACK_AGENT_TOKEN_PEPPER;
  return createHash("sha256")
    .update(value + pepper)
    .digest("hex");
}

function generateTokenString(): string {
  return crypto.randomBytes(DEVICE_TOKEN_BYTES).toString("hex");
}

// ── Bootstrap Token ────────────────────────────────────────────

/**
 * Generate a short-lived bootstrap token for a workspace.
 * Returns the plain token (shown once to the user) and an install command.
 */
export async function generateBootstrapToken(
  workspaceId: string,
  label?: string,
): Promise<BootstrapTokenResult> {
  // Verify workspace exists
  const [workspace] = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  if (!workspace) {
    throw new Error("Workspace not found");
  }

  const plainToken = generateTokenString();
  const tokenHash = sha256Pepper(plainToken);

  const expiresAt = new Date(
    Date.now() + BOOTSTRAP_TOKEN_EXPIRY_MINUTES * 60 * 1000,
  );

  await db.insert(bootstrapTokens).values({
    workspaceId,
    tokenHash,
    label: label ?? null,
    isActive: true,
    expiresAt,
  });

  // Build the install command
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://localhost:3000";
  const host = new URL(supabaseUrl).hostname;

  const installCommand = `npx ai-quota-tracker-agent register --endpoint http://${host}:3000 --token ${plainToken}`;

  return {
    token: plainToken,
    expiresAt,
    installCommand,
  };
}

/**
 * Validate and consume a bootstrap token.
 * Returns the workspace ID if valid, throws otherwise.
 */
export async function consumeBootstrapToken(
  token: string,
): Promise<string> {
  const tokenHash = sha256Pepper(token);

  const [record] = await db
    .select()
    .from(bootstrapTokens)
    .where(
      and(
        eq(bootstrapTokens.tokenHash, tokenHash),
        eq(bootstrapTokens.isActive, true),
      ),
    )
    .limit(1);

  if (!record) {
    throw new Error("Invalid bootstrap token");
  }

  // Check expiry
  if (record.expiresAt && new Date() > record.expiresAt) {
    // Deactivate the expired token so we can give a clear error
    await db
      .update(bootstrapTokens)
      .set({ isActive: false })
      .where(eq(bootstrapTokens.id, record.id));
    throw new Error("Bootstrap token has expired");
  }

  // Mark as used (inactive + set lastUsedAt) — prevents replay
  await db
    .update(bootstrapTokens)
    .set({
      isActive: false,
      lastUsedAt: new Date(),
    })
    .where(eq(bootstrapTokens.id, record.id));

  return record.workspaceId;
}

// ── Device Registration ────────────────────────────────────────

/**
 * Register a device using a bootstrap token.
 * Returns device info and the permanent device token.
 */
export async function registerDevice(
  bootstrapToken: string,
  deviceName: string,
  os: string | null,
  agentVersion: string | null,
): Promise<DeviceRegistrationResult> {
  const workspaceId = await consumeBootstrapToken(bootstrapToken);

  const deviceFingerprint = deviceName + (os ?? "unknown");
  const plainDeviceToken = generateTokenString();
  const tokenHash = sha256Pepper(plainDeviceToken);

  // Check if device already exists with same workspace+fingerprint
  // If so, update it and return existing token (re-use is safe here)
  const [existingDevice] = await db
    .select()
    .from(devices)
    .where(
      and(
        eq(devices.workspaceId, workspaceId),
        eq(devices.deviceFingerprint, deviceFingerprint),
      ),
    )
    .limit(1);

  if (existingDevice) {
    // Update existing device
    await db
      .update(devices)
      .set({
        label: deviceName,
        os: os ?? null,
        agentVersion: agentVersion ?? null,
        tokenHash,
        lastSeenAt: new Date(),
      })
      .where(eq(devices.id, existingDevice.id));

    return {
      device: {
        id: existingDevice.id,
        workspaceId: existingDevice.workspaceId,
        label: deviceName,
        os: os ?? null,
        agentVersion: agentVersion ?? null,
        deviceFingerprint: existingDevice.deviceFingerprint,
        lastSeenAt: new Date(),
        createdAt: existingDevice.createdAt,
      },
      deviceToken: plainDeviceToken,
    };
  }

  // Create new device
  const [newDevice] = await db
    .insert(devices)
    .values({
      workspaceId,
      deviceFingerprint,
      label: deviceName,
      os: os ?? null,
      agentVersion: agentVersion ?? null,
      tokenHash,
    })
    .returning();

  return {
    device: {
      id: newDevice.id,
      workspaceId: newDevice.workspaceId,
      label: newDevice.label,
      os: newDevice.os,
      agentVersion: newDevice.agentVersion,
      deviceFingerprint: newDevice.deviceFingerprint,
      lastSeenAt: newDevice.lastSeenAt,
      createdAt: newDevice.createdAt,
    },
    deviceToken: plainDeviceToken,
  };
}

// ── Device Listing ──────────────────────────────────────────────

/**
 * Get all devices for a workspace.
 */
export async function getDevicesForWorkspace(
  workspaceId: string,
): Promise<DeviceInfo[]> {
  const records = await db
    .select()
    .from(devices)
    .where(eq(devices.workspaceId, workspaceId))
    .orderBy(devices.createdAt);

  return records.map((d) => ({
    id: d.id,
    workspaceId: d.workspaceId,
    label: d.label,
    os: d.os,
    agentVersion: d.agentVersion,
    deviceFingerprint: d.deviceFingerprint,
    lastSeenAt: d.lastSeenAt,
    createdAt: d.createdAt,
  }));
}

/**
 * Validate a device token and return the device + workspace.
 */
export async function validateDeviceToken(
  token: string,
): Promise<{ deviceId: string; workspaceId: string } | null> {
  const tokenHash = sha256Pepper(token);

  const [device] = await db
    .select({ id: devices.id, workspaceId: devices.workspaceId })
    .from(devices)
    .where(eq(devices.tokenHash, tokenHash))
    .limit(1);

  if (!device) return null;
  return { deviceId: device.id, workspaceId: device.workspaceId };
}
