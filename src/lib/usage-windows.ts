import type { QuotaPoolSnapshot } from "../agent/payload";

export const CODEX_CANONICAL_WINDOWS = ["codex-5h", "codex-weekly", "codex-credits"] as const;
export const OPENCODE_GO_CANONICAL_WINDOWS = [
  "opencode-go-rolling",
  "opencode-go-weekly",
  "opencode-go-monthly",
] as const;

const CANONICAL_WINDOWS = new Set<string>([
  ...CODEX_CANONICAL_WINDOWS,
  ...OPENCODE_GO_CANONICAL_WINDOWS,
]);

export function isCanonicalWindowName(windowName: string): boolean {
  return CANONICAL_WINDOWS.has(windowName);
}

export function isLegacyWindowName(windowName: string): boolean {
  return !isCanonicalWindowName(windowName);
}

export function isPercentUsageWindow(windowName: string): boolean {
  return windowName !== "codex-credits" && isCanonicalWindowName(windowName);
}

export function expectedCanonicalWindows(pool: {
  displayName?: string;
  accountFingerprint?: string;
  kind?: string;
}): string[] {
  const label = `${pool.displayName ?? ""} ${pool.accountFingerprint ?? ""}`.toLowerCase();
  if (label.includes("codex") || label.includes("chatgpt")) return [...CODEX_CANONICAL_WINDOWS];
  if (label.includes("opencode-go") || label.includes("opencode go")) return [...OPENCODE_GO_CANONICAL_WINDOWS];
  return [];
}

export function activeCanonicalSnapshots(snapshots: QuotaPoolSnapshot[]): QuotaPoolSnapshot[] {
  const bestByWindow = new Map<string, QuotaPoolSnapshot>();
  for (const snap of snapshots) {
    if (!isCanonicalWindowName(snap.windowName)) continue;
    const existing = bestByWindow.get(snap.windowName);
    if (!existing || snapshotRank(snap) > snapshotRank(existing)) {
      bestByWindow.set(snap.windowName, snap);
    }
  }
  return [...bestByWindow.values()];
}

function snapshotRank(snapshot: QuotaPoolSnapshot): number {
  const known = snapshot.usageAmount >= 0 ? 10 : 0;
  const manual = snapshot.source?.startsWith("manual_") || snapshot.source === "manual" ? 100 : 0;
  return manual + known + (snapshot.confidence ?? 0);
}
