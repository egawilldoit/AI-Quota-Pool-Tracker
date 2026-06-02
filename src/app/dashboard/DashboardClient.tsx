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

type UsageWindowData = {
  usageAmount: string;
  windowName: string;
  windowStart: string;
  windowEnd: string;
  lastUpdatedAt: string;
  source?: string | null;
  confidence?: string | null;
};

type QuotaPoolWithUsage = {
  id: string;
  workspaceId: string;
  kind: string;
  accountFingerprint?: string;
  displayName: string;
  totalAllocated: string;
  rolloverPolicy: string;
  usageCurrent: UsageWindowData | null;
  usageWindows?: UsageWindowData[];
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

/** Is usage known (not -1 sentinel)? */
function isUsageKnown(amountStr: string): boolean {
  return Number(amountStr) >= 0;
}

function windowUsagePct(window: UsageWindowData, totalAllocated: string): number | null {
  const total = Number(totalAllocated);
  if (total <= 0) return null;
  const amt = Number(window.usageAmount);
  if (amt < 0) return null; // unknown
  return Math.min(100, Math.round((amt / total) * 100));
}

function sourceBadge(source: string | null | undefined) {
  if (!source || source === "detected" || source === "heartbeat") {
    return <Badge variant="outline" className="text-[10px]">Detected</Badge>;
  }
  if (source === "codex_cli_status" || source === "codex-status") {
    return <Badge variant="default" className="text-[10px]">CLI</Badge>;
  }
  if (source === "codex_browser_dashboard") {
    return <Badge variant="default" className="text-[10px]">Browser</Badge>;
  }
  if (source === "manual" || source === "manual_opencode_go") {
    return <Badge variant="secondary" className="text-[10px]">Manual</Badge>;
  }
  if (source === "opencode_go_browser_dashboard") {
    return <Badge variant="default" className="text-[10px]">Browser</Badge>;
  }
  return <Badge variant="outline" className="text-[10px]">{source}</Badge>;
}

function confidenceLabel(confidence: string | null | undefined): string {
  if (!confidence) return "";
  const n = Number(confidence);
  if (n >= 0.9) return "High";
  if (n >= 0.7) return "Med";
  return "Low";
}

function isStale(lastUpdatedAt: string | null | undefined, maxMin = 30): boolean {
  if (!lastUpdatedAt) return true;
  const ageMs = Date.now() - new Date(lastUpdatedAt).getTime();
  return ageMs > maxMin * 60 * 1000;
}

function staleIndicator(lastUpdatedAt: string | null | undefined): string {
  if (!lastUpdatedAt) return "Never";
  const ageMin = Math.floor((Date.now() - new Date(lastUpdatedAt).getTime()) / 60000);
  if (ageMin < 1) return "Just now";
  if (ageMin < 60) return `${ageMin}m ago`;
  const ageHr = Math.floor(ageMin / 60);
  if (ageHr < 24) return `${ageHr}h ago`;
  return `${Math.floor(ageHr / 24)}d ago`;
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

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return "Never";
  const diffMin = Math.floor((Date.now() - new Date(dateStr).getTime()) / 60000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

// ── Alert Logic ────────────────────────────────────────────────

function computeAlerts(pools: QuotaPoolWithUsage[]): PoolAlert[] {
  const alerts: PoolAlert[] = [];
  for (const pool of pools) {
    const pct = usagePercentage(pool);
    if (pct === null) continue;
    const total = Number(pool.totalAllocated);
    if (total <= 0) continue;

    let level: AlertLevel | null = null;
    if (pct >= 100) level = "exhausted";
    else if (pct >= 90) level = "critical";
    else if (pct >= 70) level = "warning";

    if (level) {
      alerts.push({
        level, poolName: pool.displayName, usagePercent: pct,
        windowName: pool.usageCurrent?.windowName ?? "—",
        source: pool.usageCurrent?.source ?? "—",
        confidence: pool.confidence,
        resetPolicy: pool.rolloverPolicy,
      });
    }
  }
  const order: Record<AlertLevel, number> = { exhausted: 0, critical: 1, warning: 2 };
  alerts.sort((a, b) => order[a.level] - order[b.level]);
  return alerts;
}

// ── Alert UI ───────────────────────────────────────────────────

const alertLevelConfig: Record<AlertLevel, { label: string; badgeClass: string; borderClass: string; bgClass: string }> = {
  warning: { label: "Warning", badgeClass: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30", borderClass: "border-amber-500/30", bgClass: "bg-amber-500/5" },
  critical: { label: "Critical", badgeClass: "bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/30", borderClass: "border-orange-500/30", bgClass: "bg-orange-500/5" },
  exhausted: { label: "Exhausted", badgeClass: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30", borderClass: "border-red-500/30", bgClass: "bg-red-500/5" },
};

function AlertsBanner({ alerts }: { alerts: PoolAlert[] }) {
  if (alerts.length === 0) return null;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <svg className="h-5 w-5 text-amber-500" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
        </svg>
        <h2 className="text-lg font-semibold">Alerts</h2>
        <Badge variant="outline" className="ml-1">{alerts.length}</Badge>
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
                  <div><span className="text-muted-foreground">Usage: </span><span className="font-medium tabular-nums">{alert.usagePercent}%</span></div>
                  <div><span className="text-muted-foreground">Window: </span><span className="font-medium">{alert.windowName}</span></div>
                  <div><span className="text-muted-foreground">Source: </span><span className="font-medium">{alert.source}</span></div>
                  <div><span className="text-muted-foreground">Confidence: </span><span className="font-medium">{alert.confidence ?? "—"}</span></div>
                  <div className="col-span-2 sm:col-span-4"><span className="text-muted-foreground">Reset: </span><span className="font-medium">{resetLabel(alert.resetPolicy)}</span></div>
                </div>
              </AlertDescription>
            </Alert>
          );
        })}
      </div>
    </div>
  );
}

// ── Pool Card (multi-window) ───────────────────────────────────

function WindowRow({ window: w, pool }: { window: UsageWindowData; pool: QuotaPoolWithUsage }) {
  const pct = windowUsagePct(w, pool.totalAllocated);
  const known = isUsageKnown(w.usageAmount);
  const stale = isStale(w.lastUpdatedAt);

  return (
    <div className="rounded-md border p-2.5 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium capitalize">{w.windowName.replace(/-/g, " ")}</span>
          {stale && known && (
            <Badge variant="outline" className="text-[10px] text-amber-500 border-amber-500/30">Stale</Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {known ? (
            <span className="text-xs tabular-nums font-semibold">{pct}%</span>
          ) : (
            <span className="text-xs text-muted-foreground">Unknown</span>
          )}
          {sourceBadge(w.source)}
        </div>
      </div>

      {known ? (
        <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct ?? 0}%` }} />
        </div>
      ) : (
        <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-muted-foreground/20" style={{ width: "100%" }} />
        </div>
      )}

      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span>Updated {staleIndicator(w.lastUpdatedAt)}</span>
        <span className="flex items-center gap-1">
          {w.confidence && <span>Conf: {confidenceLabel(w.confidence)}</span>}
        </span>
      </div>
    </div>
  );
}

function PoolCard({ pool }: { pool: QuotaPoolWithUsage }) {
  const pct = usagePercentage(pool);
  const windows = pool.usageWindows && pool.usageWindows.length > 0
    ? pool.usageWindows
    : (pool.usageCurrent ? [pool.usageCurrent] : []);

  const hasWindows = windows.length > 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle>{pool.displayName}</CardTitle>
            <CardDescription>
              <Badge variant="secondary" className="mt-1">{kindLabel(pool.kind)}</Badge>
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {pct !== null && pct >= 70 && (
              <Badge className={pct >= 100 ? "bg-red-600 text-white" : pct >= 90 ? "bg-orange-500 text-white" : "bg-amber-500 text-white"}>
                {pct >= 100 ? "Exhausted" : pct >= 90 ? "Critical" : "Warning"}
              </Badge>
            )}
            {!hasWindows && <Badge variant="ghost">No data</Badge>}
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {hasWindows ? (
          <div className="space-y-2">
            {windows.map((w) => (
              <WindowRow key={w.windowName} window={w} pool={pool} />
            ))}
          </div>
        ) : (
          <div className="space-y-1">
            <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-muted-foreground/20" style={{ width: "100%" }} />
            </div>
            <p className="text-xs text-muted-foreground">Usage unknown — run collector or enter manual usage</p>
          </div>
        )}

        <RecordManualUsageDialog pool={pool} />
      </CardContent>

      <CardFooter className="flex items-center justify-between text-xs text-muted-foreground">
        <span>Reset: <span className="font-medium text-foreground">{resetLabel(pool.rolloverPolicy)}</span></span>
      </CardFooter>
    </Card>
  );
}

// ── Record Manual Usage Dialog ─────────────────────────────────

function RecordManualUsageDialog({ pool }: { pool: QuotaPoolWithUsage }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [usageAmount, setUsageAmount] = useState("");
  const [description, setDescription] = useState("");
  const [resetTime, setResetTime] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ usageAmount: string; usagePercentage: number } | null>(null);

  const totalAlloc = Number(pool.totalAllocated);

  const handleSubmit = async () => {
    const amount = Number(usageAmount);
    if (isNaN(amount)) return;
    if (amount < 0) { setError("Usage amount cannot be negative"); return; }
    if (amount > totalAlloc) { setError(`Usage amount (${amount}) exceeds total allocated (${totalAlloc})`); return; }

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`/api/workspaces/${pool.workspaceId}/manual-usage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quotaPoolId: pool.id, usageAmount: amount,
          description: description || undefined,
          resetTime: resetTime ? new Date(resetTime).toISOString() : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        const detailMsg = data.details?.[0]?.message ?? data.error ?? "Unknown error";
        throw new Error(detailMsg);
      }
      setSuccess({ usageAmount: data.quotaPool.usageAmount, usagePercentage: data.quotaPool.usagePercentage });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submission failed");
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    setOpen(false);
    setUsageAmount(""); setDescription(""); setResetTime("");
    setError(null); setSuccess(null);
    router.refresh();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" className="w-full" />}>
        <svg className="mr-1 h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" />
        </svg>
        Record Manual Usage
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Record Manual Usage</DialogTitle>
          <DialogDescription>Record usage for <span className="font-medium">{pool.displayName}</span></DialogDescription>
        </DialogHeader>
        {success ? (
          <div className="space-y-3 py-2">
            <div className="rounded-lg bg-green-500/10 p-3">
              <p className="text-sm font-medium text-green-600 dark:text-green-400">Usage recorded successfully</p>
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
            </div>
            <DialogFooter><Button onClick={handleClose}>Done</Button></DialogFooter>
          </div>
        ) : (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Badge variant="secondary">{kindLabel(pool.kind)}</Badge>
              <span>Total: {pool.totalAllocated}</span>
            </div>
            <div className="space-y-2">
              <Label htmlFor="manual-amount">Usage Amount</Label>
              <Input id="manual-amount" type="number" step="0.01" min="0" max={totalAlloc}
                placeholder={`0 to ${totalAlloc}`} value={usageAmount}
                onChange={(e) => setUsageAmount(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="manual-desc">Description (optional)</Label>
              <Input id="manual-desc" type="text" placeholder="e.g. Weekly usage report"
                value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="manual-reset">Reset Time (optional)</Label>
              <Input id="manual-reset" type="datetime-local" value={resetTime}
                onChange={(e) => setResetTime(e.target.value)} />
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
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={submitting || !usageAmount || isNaN(Number(usageAmount))}>
              {submitting ? "Submitting..." : "Record"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Device List ────────────────────────────────────────────────

function healthBadge(healthState: string) {
  switch (healthState) {
    case "active": return <Badge className="bg-green-600 hover:bg-green-600">Active</Badge>;
    case "stale": return <Badge className="bg-yellow-500 hover:bg-yellow-500">Stale</Badge>;
    case "offline": return <Badge className="bg-red-600 hover:bg-red-600">Offline</Badge>;
    default: return <Badge variant="secondary">Unknown</Badge>;
  }
}

function DeviceCard({ device }: { device: DeviceInfo }) {
  const lastSeenInfo = device.lastHeartbeat ?? device.lastSeenAt;
  const lastSeenText = lastSeenInfo ? timeAgo(lastSeenInfo) : "Never";
  return (
    <div className="flex items-center justify-between rounded-lg border p-3">
      <div className="flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted">
          <svg className="h-4 w-4 text-muted-foreground" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 1.5H8.25A2.25 2.25 0 006 3.75v16.5a2.25 2.25 0 002.25 2.25h7.5A2.25 2.25 0 0018 20.25V3.75a2.25 2.25 0 00-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3m-3 18.75h3" />
          </svg>
        </div>
        <div>
          <p className="text-sm font-medium">{device.label || "Unnamed device"}</p>
          <p className="text-xs text-muted-foreground">
            {device.os || "Unknown OS"}{device.agentVersion ? ` · v${device.agentVersion}` : ""}{` · Seen ${lastSeenText}`}
          </p>
        </div>
      </div>
      {healthBadge(device.healthState)}
    </div>
  );
}

function DeviceList({ devices }: { devices: DeviceInfo[]; workspaceId: string }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Tracked Devices</CardTitle>
            <CardDescription>{devices.length === 1 ? "1 registered device" : `${devices.length} registered devices`}</CardDescription>
          </div>
          <Link href="/devices/add"><Button variant="outline" size="sm"><svg className="mr-1 h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>Add Device</Button></Link>
        </div>
      </CardHeader>
      <CardContent>
        {devices.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 text-center">
            <p className="text-sm text-muted-foreground">No devices registered yet.</p>
            <Link href="/devices/add" className="mt-2"><Button variant="link" size="sm">Register your first device</Button></Link>
          </div>
        ) : (
          <div className="space-y-2">
            {devices.map((device) => <DeviceCard key={device.id} device={device} />)}
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
  if (!wsList || wsList.length === 0) return { status: "empty" };

  const workspace = wsList[0];
  const workspaceId = workspace.id;

  const [poolsRes, devicesRes] = await Promise.all([
    fetch(`/api/workspaces/${workspaceId}/quota-pools`, { cache: "no-store" }),
    fetch(`/api/workspaces/${workspaceId}/devices`, { cache: "no-store" }),
  ]);

  if (!poolsRes.ok) { const body = await poolsRes.json(); throw new Error(body.error ?? `Failed to fetch quota pools (${poolsRes.status})`); }

  const poolsData = await poolsRes.json();
  const devicesData = devicesRes.ok ? await devicesRes.json() : { devices: [] };
  const devices = devicesData.devices ?? [];

  if (!poolsData.pools || poolsData.pools.length === 0) return { status: "empty", workspace, devices };

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
    (async () => {
      try {
        setState(await fetchDashboardData());
      } catch (error) {
        setState({ status: "error", message: error instanceof Error ? error.message : "An unexpected error occurred" });
      }
    })();
  }, []);

  const handleRetry = useCallback(async () => {
    setState({ status: "loading" });
    try { setState(await fetchDashboardData()); }
    catch (error) { setState({ status: "error", message: error instanceof Error ? error.message : "An unexpected error occurred" }); }
  }, []);

  const alerts = state.status === "loaded" ? computeAlerts(state.pools) : [];

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-8">
        {state.status === "loaded" && (
          <>
            <h1 className="text-2xl font-semibold tracking-tight">Quota Pool Dashboard</h1>
            <p className="mt-1 text-sm text-muted-foreground">Workspace: {state.workspace.name}</p>
          </>
        )}
        {state.status === "loading" && (
          <>
            <Skeleton className="h-8 w-64" />
            <Skeleton className="mt-2 h-4 w-40" />
          </>
        )}
      </div>

      {state.status === "loading" && (
        <div className="space-y-8">
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <Card key={i}>
                <CardHeader><Skeleton className="h-5 w-32" /><Skeleton className="h-4 w-48" /></CardHeader>
                <CardContent className="space-y-3"><Skeleton className="h-2 w-full" /><Skeleton className="h-4 w-24" /><Skeleton className="h-4 w-36" /></CardContent>
                <CardFooter><Skeleton className="h-5 w-20" /></CardFooter>
              </Card>
            ))}
          </div>
          <Separator />
          <Card><CardHeader><Skeleton className="h-5 w-32" /></CardHeader><CardContent><Skeleton className="h-8 w-full" /></CardContent></Card>
        </div>
      )}
      {state.status === "error" && (
        <Card className="border-destructive/50 p-12 text-center">
          <CardContent>
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
              <svg className="h-6 w-6 text-destructive" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
              </svg>
            </div>
            <h3 className="mb-2 text-lg font-medium">Failed to load</h3>
            <p className="mb-4 text-sm text-muted-foreground">{state.message}</p>
            <Button onClick={handleRetry}>Try again</Button>
          </CardContent>
        </Card>
      )}
      {state.status === "empty" && (
        <div className="space-y-8">
          <Card className="p-12 text-center">
            <CardContent>
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                <svg className="h-6 w-6 text-muted-foreground" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />
                </svg>
              </div>
              <h3 className="mb-2 text-lg font-medium">No quota data yet</h3>
              <p className="text-sm text-muted-foreground">No quota data yet — register device/run agent.</p>
            </CardContent>
          </Card>
          {state.workspace?.id && <DeviceList devices={state.devices ?? []} workspaceId={state.workspace.id} />}
        </div>
      )}
      {state.status === "loaded" && (
        <div className="space-y-8">
          {state.workspace.isDemoSeed && (
            <Alert>
              <AlertTitle>Demo seed data</AlertTitle>
              <AlertDescription>This workspace contains seeded demo quota pools. Register a device and run the agent to replace demo usage with real production data.</AlertDescription>
            </Alert>
          )}
          {alerts.length > 0 && (
            <>
              <AlertsBanner alerts={alerts} />
              <Separator />
            </>
          )}
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {state.pools.map((pool) => <PoolCard key={pool.id} pool={pool} />)}
          </div>
          <Separator />
          <DeviceList devices={state.devices} workspaceId={state.workspace.id} />
        </div>
      )}
    </div>
  );
}
