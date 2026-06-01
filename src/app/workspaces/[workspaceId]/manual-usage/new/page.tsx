"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  CardFooter,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

// ── Types ──────────────────────────────────────────────────────

type QuotaPoolWithUsage = {
  id: string;
  workspaceId: string;
  kind: string;
  displayName: string;
  totalAllocated: string;
  usageCurrent: {
    usageAmount: string;
  } | null;
};

type PageState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "loaded";
      pools: QuotaPoolWithUsage[];
      workspaceId: string;
    }
  | { status: "submitting" }
  | { status: "success"; result: { quotaPool: { displayName: string; usageAmount: string; usagePercentage: number; source: string } } }
  | { status: "submit-error"; message: string };

// ── Helpers ────────────────────────────────────────────────────

function kindLabel(kind: string): string {
  switch (kind) {
    case "credits": return "Credits";
    case "tokens": return "Tokens";
    case "api_calls": return "API Calls";
    default: return kind;
  }
}

// ── Page ───────────────────────────────────────────────────────

export default function ManualUsagePage() {
  const params = useParams();
  const router = useRouter();
  const workspaceId = params.workspaceId as string;

  const [state, setState] = useState<PageState>({ status: "loading" });
  const [selectedPoolId, setSelectedPoolId] = useState("");
  const [usageAmount, setUsageAmount] = useState("");
  const [description, setDescription] = useState("");
  const [resetTime, setResetTime] = useState("");
  const [cachedPools, setCachedPools] = useState<QuotaPoolWithUsage[]>([]);

  // Fetch pools on mount
  useEffect(() => {
    const fetchPools = async () => {
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/quota-pools`);
        if (!res.ok) {
          const body = await res.json();
          throw new Error(body.error ?? `Failed to fetch pools (${res.status})`);
        }
        const data = await res.json();
        const pools = data.pools ?? [];
        setCachedPools(pools);
        setState({ status: "loaded", pools, workspaceId });
        if (data.pools && data.pools.length > 0) {
          setSelectedPoolId(data.pools[0].id);
        }
      } catch (error) {
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "Failed to load quota pools",
        });
      }
    };
    fetchPools();
  }, [workspaceId]);

  const selectedPool = state.status === "loaded"
    ? state.pools.find((p) => p.id === selectedPoolId)
    : undefined;

  const handleSubmit = useCallback(async () => {
    if (!selectedPoolId) return;
    if (!usageAmount) return;

    const amount = Number(usageAmount);
    if (isNaN(amount)) return;

    const totalAlloc = selectedPool ? Number(selectedPool.totalAllocated) : 100;
    if (amount < 0) {
      setState({ status: "submit-error", message: "Usage amount cannot be negative" });
      return;
    }
    if (amount > totalAlloc) {
      setState({
        status: "submit-error",
        message: `Usage amount (${amount}) exceeds total allocated (${totalAlloc})`,
      });
      return;
    }

    setState({ status: "submitting" });

    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/manual-usage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quotaPoolId: selectedPoolId,
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

      setState({ status: "success", result: data });
    } catch (error) {
      setState({
        status: "submit-error",
        message: error instanceof Error ? error.message : "Submission failed",
      });
    }
  }, [selectedPoolId, usageAmount, description, resetTime, workspaceId, selectedPool]);

  // ── Render ───────────────────────────────────────────────────

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-6">
        <Link
          href="/dashboard"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          &larr; Back to Dashboard
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Record Manual Usage</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manually record usage for an OpenCode Go quota pool
        </p>
      </div>

      {state.status === "loading" && (
        <Card>
          <CardContent className="space-y-4 p-6">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-8 w-full" />
          </CardContent>
        </Card>
      )}

      {state.status === "error" && (
        <Card className="border-destructive/50">
          <CardContent className="p-6 text-center">
            <p className="text-destructive">{state.message}</p>
            <Button
              className="mt-4"
              variant="outline"
              onClick={() => router.push("/dashboard")}
            >
              Back to Dashboard
            </Button>
          </CardContent>
        </Card>
      )}

      {state.status === "loaded" && (
        <>
          {state.pools.length === 0 ? (
            <Card>
              <CardContent className="p-6 text-center">
                <p className="text-sm text-muted-foreground">
                  No quota pools available. Create a pool first.
                </p>
                <Button
                  className="mt-4"
                  variant="outline"
                  onClick={() => router.push("/dashboard")}
                >
                  Back to Dashboard
                </Button>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>Usage Details</CardTitle>
                <CardDescription>
                  Enter the usage amount and optional details
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Pool Selector */}
                <div className="space-y-2">
                  <Label htmlFor="pool-select">Quota Pool</Label>
                  <select
                    id="pool-select"
                    className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    value={selectedPoolId}
                    onChange={(e) => setSelectedPoolId(e.target.value)}
                  >
                    {state.pools.map((pool) => (
                      <option key={pool.id} value={pool.id}>
                        {pool.displayName} ({kindLabel(pool.kind)}) — {pool.totalAllocated} total
                      </option>
                    ))}
                  </select>
                </div>

                {selectedPool && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Badge variant="secondary">{kindLabel(selectedPool.kind)}</Badge>
                    <span>
                      {selectedPool.usageCurrent
                        ? `${selectedPool.usageCurrent.usageAmount} / ${selectedPool.totalAllocated} used`
                        : `0 / ${selectedPool.totalAllocated} used`}
                    </span>
                  </div>
                )}

                {/* Usage Amount */}
                <div className="space-y-2">
                  <Label htmlFor="usage-amount">
                    Usage Amount
                    <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="usage-amount"
                    type="number"
                    step="0.01"
                    min="0"
                    max={selectedPool ? Number(selectedPool.totalAllocated) : 100}
                    placeholder="e.g. 42.5"
                    value={usageAmount}
                    onChange={(e) => setUsageAmount(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Must be between 0 and {selectedPool ? selectedPool.totalAllocated : "the pool's total allocation"}
                  </p>
                </div>

                {/* Description */}
                <div className="space-y-2">
                  <Label htmlFor="description">Description (optional)</Label>
                  <Input
                    id="description"
                    type="text"
                    placeholder="e.g. Weekly usage report"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    maxLength={500}
                  />
                </div>

                {/* Reset Time */}
                <div className="space-y-2">
                  <Label htmlFor="reset-time">Reset Time (optional)</Label>
                  <Input
                    id="reset-time"
                    type="datetime-local"
                    value={resetTime}
                    onChange={(e) => setResetTime(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    When the usage window resets (if different from now)
                  </p>
                </div>
              </CardContent>
              <CardFooter className="flex items-center justify-between border-t px-6 py-4">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="outline">Manual</Badge>
                  <span>Confidence: 70%</span>
                </div>
                <Button
                  onClick={handleSubmit}
                  disabled={!selectedPoolId || !usageAmount || isNaN(Number(usageAmount))}
                >
                  Record Usage
                </Button>
              </CardFooter>
            </Card>
          )}
        </>
      )}

      {state.status === "submitting" && (
        <Card>
          <CardContent className="p-6 text-center">
            <div className="animate-pulse space-y-2">
              <p className="text-sm text-muted-foreground">Recording usage...</p>
            </div>
          </CardContent>
        </Card>
      )}

      {state.status === "submit-error" && (
        <Card className="border-destructive/50 mt-4">
          <CardContent className="p-6 text-center">
            <p className="text-destructive text-sm">{state.message}</p>
            <Button
              className="mt-4"
              variant="outline"
              onClick={() => setState({ status: "loaded", pools: cachedPools, workspaceId })}
            >
              Try Again
            </Button>
          </CardContent>
        </Card>
      )}

      {state.status === "success" && (
        <Card className="border-green-500/50 mt-4">
          <CardHeader>
            <CardTitle className="text-green-600 dark:text-green-400">
              Usage Recorded
            </CardTitle>
            <CardDescription>
              Manual usage has been recorded successfully
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="rounded-lg bg-muted p-4 space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Pool</span>
                <span className="font-medium">{state.result.quotaPool.displayName}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Usage</span>
                <span className="font-medium">{state.result.quotaPool.usageAmount} ({state.result.quotaPool.usagePercentage}%)</span>
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
          </CardContent>
          <CardFooter className="flex justify-between">
            <Button variant="outline" onClick={() => setState({ status: "loaded", pools: cachedPools, workspaceId })}>
              Record Another
            </Button>
            <Button onClick={() => router.push("/dashboard")}>
              Back to Dashboard
            </Button>
          </CardFooter>
        </Card>
      )}
    </div>
  );
}
