"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Alert,
  AlertTitle,
  AlertDescription,
} from "@/components/ui/alert";
import { toDashboardState } from "./data";

// ── Types ──────────────────────────────────────────────────────

type QuotaPoolWithUsage = {
  id: string;
  workspaceId: string;
  kind: string;
  accountFingerprint?: string;
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
  source?: string;
  confidence?: string;
};

type WorkspaceInfo = {
  id: string;
  name: string;
  slug: string;
  isDemoSeed?: boolean;
};

type DeviceInfo = {
  id: string;
  workspaceId: string;
  label: string | null;
  os: string | null;
  agentVersion: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  healthState: "active" | "stale" | "offline" | "unknown";
  lastHeartbeat: string | null;
  freshnessMinutes: number | null;
};

type DashboardState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "empty"; workspace?: WorkspaceInfo; devices?: DeviceInfo[] }
  | {
      status: "loaded";
      workspace: WorkspaceInfo;
      pools: QuotaPoolWithUsage[];
      devices: DeviceInfo[];
    };

// ── Alert Types ────────────────────────────────────────────────

type AlertLevel = "warning" | "critical" | "exhausted";

type PoolAlert = {
  level: AlertLevel;
  poolName: string;
  usagePercent: number;
  windowName: string;
  source: string;
  confidence: string | undefined;
  resetPolicy: string;
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
  if (pool.source === "manual" || pool.confidence === "0.700") {
    return <Badge variant="secondary">Manual</Badge>;
  }
  return <Badge variant="default">Confirmed</Badge>;
}

function sourceLabel(pool: QuotaPoolWithUsage): string {
  if (!pool.usageCurrent) return "—";
  if (pool.source === "manual") return "Manual";
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

// ── Alert Logic ────────────────────────────────────────────────

function computeAlerts(pools: QuotaPoolWithUsage[]): PoolAlert[] {
  const alerts: PoolAlert[] = [];

  for (const pool of pools) {
    const pct = usagePercentage(pool);
    // Unknown usage: no usageCurrent, no totalAllocated, or pct is null → skip
    if (pct === null) continue;
    const total = Number(pool.totalAllocated);
    if (total <= 0) continue;

    let level: AlertLevel | null = null;
    if (pct >= 100) {
      level = "exhausted";
    } else if (pct >= 90) {
      level = "critical";
    } else if (pct >= 70) {
      level = "warning";
    }

    if (level) {
      alerts.push({
        level,
        poolName: pool.displayName,
        usagePercent: pct,
        windowName: pool.usageCurrent?.windowName ?? "—",
        source: sourceLabel(pool),
        confidence: pool.confidence,
        resetPolicy: pool.rolloverPolicy,
      });
    }
  }

  // Sort: exhausted first, then critical, then warning
  const levelOrder: Record<AlertLevel, number> = { exhausted: 0, critical: 1, warning: 2 };
  alerts.sort((a, b) => levelOrder[a.level] - levelOrder[b.level]);

  return alerts;
}

// ── Alert UI ───────────────────────────────────────────────────

const alertLevelConfig: Record<AlertLevel, { label: string; badgeClass: string; borderClass: string; bgClass: string }> = {
  warning: {
    label: "Warning",
    badgeClass: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30",
    borderClass: "border-amber-500/30",
    bgClass: "bg-amber-500/5",
  },
  critical: {
    label: "Critical",
    badgeClass: "bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/30",
    borderClass: "border-orange-500/30",
    bgClass: "bg-orange-500/5",
  },
  exhausted: {
    label: "Exhausted",
    badgeClass: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30",
    borderClass: "border-red-500/30",
    bgClass: "bg-red-500/5",
  },
};

function AlertsBanner({ alerts }: { alerts: PoolAlert[] }) {
  if (alerts.length === 0) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <svg
          className="h-5 w-5 text-amber-500"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
          />
        </svg>
        <h2 className="text-lg font-semibold">Alerts</h2>
        <Badge variant="outline" className="ml-1">
          {alerts.length}
        </Badge>
      </div>
      <div className="space-y-2">
        {alerts.map((alert, idx) => {
          const cfg = alertLevelConfig[alert.level];
          return (
            <Alert key={`${alert.poolName}-${idx}`} className={`${cfg.borderClass} ${cfg.bgClass}`}>
              <AlertTitle className="flex items-center gap-2">
                <Badge className={cfg.badgeClass}>{cfg.label}</Badge>
                <span className="font-medium">{alert.poolName}</span>
              </AlertTitle>
              <AlertDescription>
                <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
                  <div>
                    <span className="text-muted-foreground">Usage: </span>
                    <span className="font-medium tabular-nums">{alert.usagePercent}%</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Window: </span>
                    <span className="font-medium">{alert.windowName}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Source: </span>
                    <span className="font-medium">{alert.source}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Confidence: </span>
                    <span className="font-medium">{alert.confidence ?? "—"}</span>
                  </div>
                  <div className="col-span-2 sm:col-span-4">
                    <span className="text-muted-foreground">Reset: </span>
                    <span className="font-medium">{resetLabel(alert.resetPolicy)}</span>
                  </div>
                </div>
              </AlertDescription>
            </Alert>
          );
        })}
      </div>
    </div>
  );
}

function PoolAlertBadge({ pct }: { pct: number | null }) {
  if (pct === null) return null;

  let label: string;
  let className: string;

  if (pct >= 100) {
    label = "Exhausted";
    className = "bg-red-600 hover:bg-red-600 text-white";
  } else if (pct >= 90) {
    label = "Critical";
    className = "bg-orange-500 hover:bg-orange-500 text-white";
  } else if (pct >= 70) {
    label = "Warning";
    className = "bg-amber-500 hover:bg-amber-500 text-white";
  } else {
    return null;
  }

  return <Badge className={className}>{label}</Badge>;
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
          <h3 className="mb-2 text-lg font-medium">No quota data yet</h3>
          <p className="text-sm text-muted-foreground">
            No quota data yet — register device/run agent.
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
          <div className="flex items-center gap-2">
            <PoolAlertBadge pct={pct} />
            {confidenceBadge(pool)}
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <UsageBar percentage={pct} variant={hasUsage ? "known" : "unknown"} />

        {hasUsage && (
          <p className="text-sm text-muted-foreground">{usageLabel(pool)}</p>
        )}

        <RecordManualUsageDialog pool={pool} />
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

function RecordManualUsageDialog({ pool }: { pool: QuotaPoolWithUsage }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [usageAmount, setUsageAmount] = useState("");
  const [description, setDescription] = useState("");
  const [resetTime, setResetTime] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{
    usageAmount: string;
    usagePercentage: number;
  } | null>(null);

  const totalAlloc = Number(pool.totalAllocated);

  const handleSubmit = async () => {
    const amount = Number(usageAmount);
    if (isNaN(amount)) return;

    if (amount < 0) {
      setError("Usage amount cannot be negative");
      return;
    }
    if (amount > totalAlloc) {
      setError(`Usage amount (${amount}) exceeds total allocated (${totalAlloc})`);
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`/api/workspaces/${pool.workspaceId}/manual-usage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quotaPoolId: pool.id,
          usageAmount: amount,
          description: description || undefined,
          resetTime: resetTime ? new Date(resetTime).toISOString() : undefined,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        const detailMsg = data.details?.[0]?.message ?? data.error ?? "Unknown error";
        throw new Error(detailMsg);
      }

      setSuccess({
        usageAmount: data.quotaPool.usageAmount,
        usagePercentage: data.quotaPool.usagePercentage,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submission failed");
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    setOpen(false);
    setUsageAmount("");
    setDescription("");
    setResetTime("");
    setError(null);
    setSuccess(null);
    router.refresh();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" className="w-full" />}>
        <svg
          className="mr-1 h-4 w-4"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182"
          />
        </svg>
        Record Manual Usage
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Record Manual Usage</DialogTitle>
          <DialogDescription>
            Record usage for <span className="font-medium">{pool.displayName}</span>
          </DialogDescription>
        </DialogHeader>

        {success ? (
          <div className="space-y-3 py-2">
            <div className="rounded-lg bg-green-500/10 p-3">
              <p className="text-sm font-medium text-green-600 dark:text-green-400">
                Usage recorded successfully
              </p>
            </div>
            <div className="rounded-lg bg-muted p-3 space-y-1.5">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Usage</span>
                <span className="font-medium">{success.usageAmount} ({success.usagePercentage}%)</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Source</span>
                <Badge variant="secondary">Manual</Badge>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Confidence</span>
                <Badge variant="outline">70%</Badge>
              </div>
            </div>
            <DialogFooter>
              <Button onClick={handleClose}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Badge variant="secondary">{kindLabel(pool.kind)}</Badge>
              <span>Total: {pool.totalAllocated}</span>
            </div>

            <div className="space-y-2">
              <Label htmlFor="manual-amount">Usage Amount</Label>
              <Input
                id="manual-amount"
                type="number"
                step="0.01"
                min="0"
                max={totalAlloc}
                placeholder={`0 to ${totalAlloc}`}
                value={usageAmount}
                onChange={(e) => setUsageAmount(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="manual-desc">Description (optional)</Label>
              <Input
                id="manual-desc"
                type="text"
                placeholder="e.g. Weekly usage report"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={500}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="manual-reset">Reset Time (optional)</Label>
              <Input
                id="manual-reset"
                type="datetime-local"
                value={resetTime}
                onChange={(e) => setResetTime(e.target.value)}
              />
            </div>

            {error && (
              <div className="rounded-lg bg-destructive/10 p-2.5">
                <p className="text-xs text-destructive">{error}</p>
              </div>
            )}
          </div>
        )}

        {!success && (
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={submitting || !usageAmount || isNaN(Number(usageAmount))}
            >
              {submitting ? "Submitting..." : "Record"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Device Card ────────────────────────────────────────────────

function healthBadge(healthState: string) {
  switch (healthState) {
    case "active":
      return <Badge className="bg-green-600 hover:bg-green-600">Active</Badge>;
    case "stale":
      return <Badge className="bg-yellow-500 hover:bg-yellow-500">Stale</Badge>;
    case "offline":
      return <Badge className="bg-red-600 hover:bg-red-600">Offline</Badge>;
    default:
      return <Badge variant="secondary">Unknown</Badge>;
  }
}

function DeviceCard({ device }: { device: DeviceInfo }) {
  const lastSeenInfo = device.lastHeartbeat ?? device.lastSeenAt;
  const lastSeenText = lastSeenInfo ? timeAgo(lastSeenInfo) : "Never";
  const osInfo = device.os || "Unknown OS";
  const agentInfo = device.agentVersion ? `v${device.agentVersion}` : null;

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
            {osInfo}
            {agentInfo ? ` · ${agentInfo}` : ""}
            {` · Seen ${lastSeenText}`}
          </p>
        </div>
      </div>
      {healthBadge(device.healthState)}
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
  const res = await fetch("/api/workspaces", { cache: "no-store" });
  if (!res.ok) {
    const body = await res.json();
    throw new Error(body.error ?? `Failed to fetch workspaces (${res.status})`);
  }
  const { workspaces: wsList } = await res.json();

  if (!wsList || wsList.length === 0) {
    return { status: "empty" };
  }

  const workspace = wsList[0];
  const workspaceId = workspace.id;

  // Fetch pools and devices in parallel
  const [poolsRes, devicesRes] = await Promise.all([
    fetch(`/api/workspaces/${workspaceId}/quota-pools`, { cache: "no-store" }),
    fetch(`/api/workspaces/${workspaceId}/devices`, { cache: "no-store" }),
  ]);

  if (!poolsRes.ok) {
    const body = await poolsRes.json();
    throw new Error(body.error ?? `Failed to fetch quota pools (${poolsRes.status})`);
  }

  const poolsData = await poolsRes.json();
  const devicesData = devicesRes.ok ? await devicesRes.json() : { devices: [] };
  const devices = devicesData.devices ?? [];

  if (!poolsData.pools || poolsData.pools.length === 0) {
    return { status: "empty", workspace, devices };
  }

  return toDashboardState(
    { ...poolsData.workspace, isDemoSeed: workspace.isDemoSeed },
    poolsData.pools,
    devices,
  );
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

  const alerts = state.status === "loaded" ? computeAlerts(state.pools) : [];

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
      {state.status === "empty" && (
        <>
          <EmptyState workspaceId={state.workspace?.id} />
          {state.devices && state.devices.length > 0 && (
            <div className="mt-8">
              <DeviceList devices={state.devices} workspaceId={state.workspace?.id ?? ""} />
            </div>
          )}
        </>
      )}
      {state.status === "loaded" && (
        <div className="space-y-8">
          {state.workspace.isDemoSeed && (
            <Alert>
              <AlertTitle>Demo seed data</AlertTitle>
              <AlertDescription>
                This workspace contains seeded demo quota pools. Register a device and run the agent
                to replace demo usage with real production data.
              </AlertDescription>
            </Alert>
          )}
          {alerts.length > 0 && (
            <>
              <AlertsBanner alerts={alerts} />
              <Separator />
            </>
          )}

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
