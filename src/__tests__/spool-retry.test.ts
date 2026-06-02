import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// We import the actual module but test it via filesystem assertions
// to avoid module-level side effects on test environment
import {
  writeSpool,
  readSpool,
  deleteSpoolEntry,
  getSpoolHealth,
} from "@/agent/spool";

// Test spool dir path (same as module)
const SPOOL_DIR = join(homedir(), ".local", "share", "ega-devtrack", "spool");

describe("spool retry limits", () => {
  const minimalPayload = {
    device: { deviceFingerprint: "test-fp", agentVersion: "0.1.0", os: "linux" },
    quotaPoolSnapshots: [],
    toolQuotaAttributions: [],
    toolInfos: [],
  };

  beforeAll(async () => {
    // Ensure spool dir exists for tests
    if (!existsSync(SPOOL_DIR)) {
      mkdirSync(SPOOL_DIR, { recursive: true });
    }
  });

  afterAll(() => {
    // Cleanup test entries only — leave real ones
    for (const f of readdirSync(SPOOL_DIR)) {
      if (f.includes("test-entry-")) {
        try { unlinkSync(join(SPOOL_DIR, f)); } catch { /* ok */ }
      }
    }
  });

  it("new entry has retryCount = 0", () => {
    const id = writeSpool(minimalPayload);
    expect(id).toBeTruthy();
    if (id) {
      const fp = join(SPOOL_DIR, `${id}.json`);
      const content = JSON.parse(readFileSync(fp, "utf-8"));
      expect(content.retryCount).toBe(0);
      expect(content.lastRetryAt).toBeNull();
      deleteSpoolEntry(id);
    }
  });

  it("entry with retryCount >= 3 is filtered out by readSpool", () => {
    // Create an entry that looks like it has 3 retries
    const id = "test-entry-rejected";
    const fp = join(SPOOL_DIR, `${id}.json`);
    const staleEntry = {
      id,
      createdAt: new Date().toISOString(),
      retryCount: 3,
      lastRetryAt: new Date().toISOString(),
      payload: minimalPayload,
    };
    writeFileSync(fp, JSON.stringify(staleEntry), "utf-8");

    // readSpool should NOT include it
    const entries = readSpool();
    const found = entries.find((e) => e.id === id);
    expect(found).toBeUndefined();

    // The file should have been removed
    expect(existsSync(fp)).toBe(false);
  });

  it("entry with retryCount = 2 is still retried", () => {
    const id = "test-entry-retriable";
    const fp = join(SPOOL_DIR, `${id}.json`);
    const retriableEntry = {
      id,
      createdAt: new Date().toISOString(),
      retryCount: 2,
      lastRetryAt: new Date().toISOString(),
      payload: minimalPayload,
    };
    writeFileSync(fp, JSON.stringify(retriableEntry), "utf-8");

    const entries = readSpool();
    const found = entries.find((e) => e.id === id);
    expect(found).toBeTruthy();
    expect(found!.retryCount).toBe(2);

    // Clean up
    deleteSpoolEntry(id);
  });

  it("deleteSpoolEntry removes the file", () => {
    const id = writeSpool(minimalPayload);
    expect(id).toBeTruthy();
    if (id) {
      const fp = join(SPOOL_DIR, `${id}.json`);
      expect(existsSync(fp)).toBe(true);
      deleteSpoolEntry(id);
      expect(existsSync(fp)).toBe(false);
    }
  });
});
