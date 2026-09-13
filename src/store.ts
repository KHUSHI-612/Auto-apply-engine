import * as crypto from "node:crypto";
import type { Profile, RunRecord, TraceEntry } from "./types.js";

// In-memory runs store
const runs = new Map<string, RunRecord>();

/**
 * Creates and stores a new application run record.
 */
export function createRun(
  jobUrl: string,
  adapterName: string,
  profile: Profile
): RunRecord {
  const runId = `run_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const now = new Date().toISOString();

  const record: RunRecord = {
    runId,
    jobUrl,
    adapterName,
    profile,
    state: "CREATED",
    trace: [],
    createdAt: now,
    updatedAt: now,
  };

  runs.set(runId, record);
  return { ...record };
}

/**
 * Retrieves a run record by runId.
 */
export function getRun(runId: string): RunRecord | undefined {
  const record = runs.get(runId);
  return record ? { ...record, trace: [...record.trace] } : undefined;
}

/**
 * Updates a run record with new fields.
 */
export function updateRun(
  runId: string,
  updates: Partial<RunRecord>
): RunRecord {
  const existing = runs.get(runId);
  if (!existing) {
    throw new Error(`Run with id '${runId}' does not exist in store.`);
  }

  const updated: RunRecord = {
    ...existing,
    ...updates,
    runId, // Preserve original runId
    updatedAt: new Date().toISOString(),
  };

  runs.set(runId, updated);
  return { ...updated, trace: [...updated.trace] };
}

/**
 * Appends a trace entry to a run's execution history.
 */
export function appendTrace(runId: string, entry: TraceEntry): void {
  const existing = runs.get(runId);
  if (!existing) {
    throw new Error(`Run with id '${runId}' does not exist in store.`);
  }

  existing.trace.push({ ...entry });
  existing.updatedAt = new Date().toISOString();
}

/**
 * Clears the in-memory store (useful for test isolation).
 */
export function clearStore(): void {
  runs.clear();
}

/**
 * Returns all stored run records in reverse chronological order.
 */
export function getAllRuns(): RunRecord[] {
  return Array.from(runs.values())
    .map((r) => ({ ...r, trace: [...r.trace] }))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

