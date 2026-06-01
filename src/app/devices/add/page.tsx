"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

// ── Types ──────────────────────────────────────────────────────

type WorkspaceInfo = {
  id: string;
  name: string;
  slug: string;
};

type PageState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      workspace: WorkspaceInfo;
    }
  | {
      status: "token_generated";
      workspace: WorkspaceInfo;
      token: string;
      expiresAt: string;
      installCommand: string;
    };

// ── Add Device Page ─────────────────────────────────────────────

export default function AddDevicePage() {
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [label, setLabel] = useState("");

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch("/api/workspaces");
        if (!res.ok) {
          const body = await res.json();
          throw new Error(body.error ?? `Failed to fetch workspaces (${res.status})`);
        }
        const { workspaces: wsList } = await res.json();
        if (!wsList || wsList.length === 0) {
          setState({ status: "error", message: "No workspaces found. Create a workspace first." });
          return;
        }
        setState({
          status: "ready",
          workspace: wsList[0],
        });
      } catch (error) {
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "An unexpected error occurred",
        });
      }
    };
    load();
  }, []);

  const handleGenerateToken = useCallback(async () => {
    if (state.status !== "ready") return;

    try {
      const res = await fetch(`/api/workspaces/${state.workspace.id}/bootstrap-tokens`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label || undefined }),
      });

      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? `Failed to generate token (${res.status})`);
      }

      const data = await res.json();
      setState({
        status: "token_generated",
        workspace: state.workspace,
        token: data.token,
        expiresAt: data.expiresAt,
        installCommand: data.installCommand,
      });
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "An unexpected error occurred",
      });
    }
  }, [state, label]);

  const handleReset = useCallback(() => {
    if (state.status === "token_generated") {
      setState({ status: "ready", workspace: state.workspace });
      setLabel("");
    }
  }, [state]);

  const handleCopy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback
      const textarea = document.createElement("textarea");
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
  }, []);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Add Device</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Generate a bootstrap token to register a new tracked device.
        </p>
      </div>

      {state.status === "loading" && (
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-4 w-48" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-8 w-full" />
          </CardContent>
        </Card>
      )}

      {state.status === "error" && (
        <Card className="border-destructive/50">
          <CardHeader>
            <CardTitle className="text-destructive">Error</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">{state.message}</p>
          </CardContent>
          <CardFooter>
            <Button onClick={() => window.location.reload()}>Try again</Button>
          </CardFooter>
        </Card>
      )}

      {state.status === "ready" && (
        <Card>
          <CardHeader>
            <CardTitle>Generate Bootstrap Token</CardTitle>
            <CardDescription>
              This token is short-lived (15 minutes) and can be used to register a device. Paste it into the device agent installation command.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium">Workspace</label>
              <Badge variant="secondary" className="text-sm">
                {state.workspace.name}
              </Badge>
            </div>
            <div>
              <label htmlFor="label" className="mb-1 block text-sm font-medium">
                Label (optional)
              </label>
              <Input
                id="label"
                placeholder="e.g. Production server"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
          </CardContent>
          <CardFooter>
            <Button onClick={handleGenerateToken}>Generate Bootstrap Token</Button>
          </CardFooter>
        </Card>
      )}

      {state.status === "token_generated" && (
        <div className="space-y-6">
          <Card className="border-green-500/50">
            <CardHeader>
              <CardTitle className="text-green-600 dark:text-green-400">
                Token Generated
              </CardTitle>
              <CardDescription>
                Copy the bootstrap token and use it with your device agent installation. This token will expire in 15 minutes and can only be used once.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium">Bootstrap Token</label>
                <div className="flex gap-2">
                  <Input
                    readOnly
                    value={state.token}
                    className="font-mono text-xs"
                  />
                  <Button variant="outline" onClick={() => handleCopy(state.token)}>
                    Copy
                  </Button>
                </div>
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium">Install Command</label>
                <div className="flex gap-2">
                  <Input
                    readOnly
                    value={state.installCommand}
                    className="font-mono text-xs"
                  />
                  <Button variant="outline" onClick={() => handleCopy(state.installCommand)}>
                    Copy
                  </Button>
                </div>
              </div>

              <p className="text-xs text-muted-foreground">
                Expires at: {new Date(state.expiresAt).toLocaleString()}
              </p>
            </CardContent>
            <CardFooter>
              <Button variant="outline" onClick={handleReset}>
                Generate Another Token
              </Button>
            </CardFooter>
          </Card>
        </div>
      )}
    </div>
  );
}
