"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  CardFooter,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

// ── Types ──────────────────────────────────────────────────────

type QuotaPoolWithUsage = {
  id: string;
  workspaceId: string;
  kind: string;
  displayName: string;
  totalAllocated: string;
  rolloverPolicy: string;
  usageCurrent: {
    usageAmount: string;
    windowName: string;
    windowStart: string;
    windowEnd: string;
    lastUpdatedAt: string;
  } | null;
};

type WorkspaceInfo = {
  id: string;
  name: string;
  slug: string;
};

type DeviceInfo = {
  id: string;
  workspaceId: string;
  label: string | null;
  os: string | null;
  agentVersion: string | null;
  lastSeenAt: string | null;
  createdAt: string;
};

type DashboardState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "empty" }
  | {
      status: "loaded";
      workspace: WorkspaceInfo;
      pools: QuotaPoolWithUsage[];
      devices: DeviceInfo[];
    };

// ── Helpers ────────────────────────────────────────────────────

function usagePercentage(pool: QuotaPoolWithUsage): number | null {
  if (!pool.usageCurrent) return null;
  const total = Number(pool.totalAllocated);
  if (total <= 0) return 0;
  return Math.min(100, Math.round((Number(pool.usageCurrent.usageAmount) / total) * 100));
}

function usageLabel(pool: QuotaPoolWithUsage): string {
  if (!pool.usageCurrent) return "Usage unknown";
  const pct = usagePercentage(pool);
  const used = Number(pool.usageCurrent.usageAmount);
  const total = Number(pool.totalAllocated);
  return `${pct}% used (${used.toLocaleString()} / ${total.toLocaleString()})`;
}

function resetLabel(policy: string): string {
  switch (policy) {
    case "none": return "No auto-reset";
    case "full": return "Resets fully";
    case "capped": return "Resets (capped)";
    default: return policy;
  }
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "credits": return "Credits";
    case "tokens": return "Tokens";
    case "api_calls": return "API Calls";
    default: return kind;
  }
}

function confidenceBadge(pool: QuotaPoolWithUsage) {
  if (!pool.usageCurrent) {
    return <Badge variant="ghost">No data</Badge>;
  }
  return <Badge variant="default">Confirmed</Badge>;
}

function sourceLabel(pool: QuotaPoolWithUsage): string {
  if (!pool.usageCurrent) return "—";
  return "System";
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return "Never";
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

// ── Loading Skeleton ───────────────────────────────────────────

function DashboardSkeleton() {
  return (
    <div className="space-y-8">
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-4 w-48" />
            </CardHeader>
            <CardContent className="space-y-3">
              <Skeleton className="h-2 w-full" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-36" />
            </CardContent>
            <CardFooter>
              <Skeleton className="h-5 w-20" />
            </CardFooter>
          </Card>
        ))}
      </div>
      <Separator />
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-32" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-8 w-full" />
        </CardContent>
      </Card>
    </div>
  );
}

// ── Empty State ────────────────────────────────────────────────

function EmptyState({ workspaceId }: { workspaceId?: string }) {
  return (
    <div className="space-y-8">
      <Card className="p-12 text-center">
        <CardContent>
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <svg
              className="h-6 w-6 text-muted-foreground"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125"
              />
            </svg>
          </div>
          <h3 className="mb-2 text-lg font-medium">No quota pools</h3>
          <p className="text-sm text-muted-foreground">
            No quota pools have been configured yet. Add a quota pool to get started.
          </p>
        </CardContent>
      </Card>

      {workspaceId && (
        <Card>
          <CardHeader>
            <CardTitle>Tracked Devices</CardTitle>
            <CardDescription>
              Register devices to track their AI tool usage.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex items-center justify-center py-6">
            <Link href="/devices/add">
              <Button>Add Device</Button>
            </Link>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ── Error State ────────────────────────────────────────────────

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card className="border-destructive/50 p-12 text-center">
      <CardContent>
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
          <svg
            className="h-6 w-6 text-destructive"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
            />
          </svg>
        </div>
        <h3 className="mb-2 text-lg font-medium">Failed to load</h3>
        <p className="mb-4 text-sm text-muted-foreground">{message}</p>
        <button
          onClick={onRetry}
          className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Try again
        </button>
      </CardContent>
    </Card>
  );
}

// ── Usage Progress Bar ─────────────────────────────────────────

function UsageBar({ percentage, variant }: { percentage: number | null; variant: "known" | "unknown" }) {
  if (variant === "unknown") {
    return (
      <div className="space-y-1">
        <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-muted-foreground/20"
            style={{ width: "100%" }}
          />
        </div>
        <p className="text-xs text-muted-foreground">Usage data unavailable</p>
      </div>
    );
  }

  const pct = percentage ?? 0;

  return (
    <Progress value={pct}>
      <span className="flex w-full items-center justify-between gap-2">
        <span className="text-sm font-medium">Usage</span>
        <span className="text-sm text-muted-foreground tabular-nums">{pct}%</span>
      </span>
    </Progress>
  );
}

// ── Pool Card ──────────────────────────────────────────────────

function PoolCard({ pool }: { pool: QuotaPoolWithUsage }) {
  const pct = usagePercentage(pool);
  const hasUsage = pool.usageCurrent !== null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle>{pool.displayName}</CardTitle>
            <CardDescription>
              <Badge variant="secondary" className="mt-1">
                {kindLabel(pool.kind)}
              </Badge>
            </CardDescription>
          </div>
          {confidenceBadge(pool)}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <UsageBar percentage={pct} variant={hasUsage ? "known" : "unknown"} />

        {hasUsage && (
          <p className="text-sm text-muted-foreground">{usageLabel(pool)}</p>
        )}
      </CardContent>

      <CardFooter className="flex items-center justify-between text-xs text-muted-foreground">
        <div className="flex items-center gap-3">
          <span>
            Reset: <span className="font-medium text-foreground">{resetLabel(pool.rolloverPolicy)}</span>
          </span>
          <span className="text-border">|</span>
          <span>
            Source: <span className="font-medium text-foreground">{sourceLabel(pool)}</span>
          </span>
        </div>
      </CardFooter>
    </Card>
  );
}

// ── Device Card ────────────────────────────────────────────────

function DeviceCard({ device }: { device: DeviceInfo }) {
  return (
    <div className="flex items-center justify-between rounded-lg border p-3">
      <div className="flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted">
          <svg
            className="h-4 w-4 text-muted-foreground"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M10.5 1.5H8.25A2.25 2.25 0 006 3.75v16.5a2.25 2.25 0 002.25 2.25h7.5A2.25 2.25 0 0018 20.25V3.75a2.25 2.25 0 00-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3m-3 18.75h3"
            />
          </svg>
        </div>
        <div>
          <p className="text-sm font-medium">{device.label || "Unnamed device"}</p>
          <p className="text-xs text-muted-foreground">
            {device.os || "Unknown OS"}
            {device.agentVersion ? ` · v${device.agentVersion}` : ""}
            {device.lastSeenAt ? ` · Seen ${timeAgo(device.lastSeenAt)}` : " · Never seen"}
          </p>
        </div>
      </div>
      <Badge variant={device.lastSeenAt ? "default" : "ghost"}>
        {device.lastSeenAt ? "Active" : "Pending"}
      </Badge>
    </div>
  );
}

// ── Device List ────────────────────────────────────────────────

function DeviceList({ devices: devicesList }: { devices: DeviceInfo[]; workspaceId: string }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Tracked Devices</CardTitle>
            <CardDescription>
              {devicesList.length === 1
                ? "1 registered device"
                : `${devicesList.length} registered devices`}
            </CardDescription>
          </div>
          <Link href="/devices/add">
            <Button variant="outline" size="sm">
              <svg
                className="mr-1 h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              Add Device
            </Button>
          </Link>
        </div>
      </CardHeader>
      <CardContent>
        {devicesList.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 text-center">
            <p className="text-sm text-muted-foreground">No devices registered yet.</p>
            <Link href="/devices/add" className="mt-2">
              <Button variant="link" size="sm">
                Register your first device
              </Button>
            </Link>
          </div>
        ) : (
          <div className="space-y-2">
            {devicesList.map((device) => (
              <DeviceCard key={device.id} device={device} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Data Fetching ──────────────────────────────────────────────

async function fetchDashboardData(): Promise<DashboardState> {
  const res = await fetch("/api/workspaces");
  if (!res.ok) {
    const body = await res.json();
    throw new Error(body.error ?? `Failed to fetch workspaces (${res.status})`);
  }
  const { workspaces: wsList } = await res.json();

  if (!wsList || wsList.length === 0) {
    return { status: "empty" };
  }

  const workspaceId = wsList[0].id;

  // Fetch pools and devices in parallel
  const [poolsRes, devicesRes] = await Promise.all([
    fetch(`/api/workspaces/${workspaceId}/quota-pools`),
    fetch(`/api/workspaces/${workspaceId}/devices`),
  ]);

  if (!poolsRes.ok) {
    const body = await poolsRes.json();
    throw new Error(body.error ?? `Failed to fetch quota pools (${poolsRes.status})`);
  }

  const poolsData = await poolsRes.json();
  const devicesData = devicesRes.ok ? await devicesRes.json() : { devices: [] };

  if (!poolsData.pools || poolsData.pools.length === 0) {
    return { status: "empty" };
  }

  return {
    status: "loaded" as const,
    workspace: poolsData.workspace,
    pools: poolsData.pools,
    devices: devicesData.devices ?? [],
  };
}

// ── Dashboard Page ─────────────────────────────────────────────

export default function DashboardPage() {
  const [state, setState] = useState<DashboardState>({ status: "loading" });

  useEffect(() => {
    const onMount = async () => {
      try {
        const newState = await fetchDashboardData();
        setState(newState);
      } catch (error) {
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "An unexpected error occurred",
        });
      }
    };
    onMount();
  }, []);

  const handleRetry = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const newState = await fetchDashboardData();
      setState(newState);
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "An unexpected error occurred",
      });
    }
  }, []);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-8">
        {state.status === "loaded" && (
          <>
            <h1 className="text-2xl font-semibold tracking-tight">Quota Pool Dashboard</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Workspace: {state.workspace.name}
            </p>
          </>
        )}
        {state.status === "loading" && (
          <>
            <Skeleton className="h-8 w-64" />
            <Skeleton className="mt-2 h-4 w-40" />
          </>
        )}
      </div>

      {state.status === "loading" && <DashboardSkeleton />}
      {state.status === "error" && <ErrorState message={state.message} onRetry={handleRetry} />}
      {state.status === "empty" && <EmptyState />}
      {state.status === "loaded" && (
        <div className="space-y-8">
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {state.pools.map((pool) => (
              <PoolCard key={pool.id} pool={pool} />
            ))}
          </div>

          <Separator />

          <DeviceList devices={state.devices} workspaceId={state.workspace.id} />
        </div>
      )}
    </div>
  );
}
