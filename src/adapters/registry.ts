import type { AtsAdapter } from "../types.js";
import { leverAdapter } from "./lever.js";
import { greenhouseAdapter } from "./greenhouse.js";

export interface AdapterRegistration {
  hostIncludes: string;
  adapter: AtsAdapter;
}

const registeredAdapters: AdapterRegistration[] = [
  { hostIncludes: "lever.co", adapter: leverAdapter },
  { hostIncludes: "greenhouse.io", adapter: greenhouseAdapter },
];

const adapters: AtsAdapter[] = [leverAdapter, greenhouseAdapter];

/**
 * Registers an ATS adapter with the registry.
 */
export function registerAdapter(adapter: AtsAdapter): void {
  const existingIdx = adapters.findIndex((a) => a.name === adapter.name);
  if (existingIdx >= 0) {
    adapters[existingIdx] = adapter;
  } else {
    adapters.push(adapter);
  }
}

/**
 * Returns all registered ATS adapters.
 */
export function getRegisteredAdapters(): AtsAdapter[] {
  return [...adapters];
}

/**
 * Detects and returns the appropriate ATS adapter for a given job URL.
 * Throws an Error if no matching adapter is found.
 */
export function detectAdapter(jobUrl: string): AtsAdapter {
  if (!jobUrl || typeof jobUrl !== "string") {
    throw new Error(`Invalid job URL provided: '${jobUrl}'`);
  }

  try {
    const parsed = new URL(jobUrl);
    const hostname = parsed.hostname.toLowerCase();

    // Lever ATS: jobs.lever.co (or localhost mock endpoints during testing)
    if (
      hostname === "jobs.lever.co" ||
      hostname.endsWith(".lever.co") ||
      ((hostname === "localhost" || hostname === "127.0.0.1") && (jobUrl.includes("lever.co") || jobUrl.includes("lever")))
    ) {
      const adapter = adapters.find((a) => a.name === "lever");
      if (adapter) return adapter;
    }

    // Greenhouse ATS: job-boards.greenhouse.io / boards.greenhouse.io (or localhost mock endpoints)
    if (
      hostname === "greenhouse.io" ||
      hostname.endsWith(".greenhouse.io") ||
      ((hostname === "localhost" || hostname === "127.0.0.1") && (jobUrl.includes("greenhouse.io") || jobUrl.includes("greenhouse")))
    ) {
      const adapter = adapters.find((a) => a.name === "greenhouse");
      if (adapter) return adapter;
    }

    // Host matching against registered adapters
    for (const reg of registeredAdapters) {
      if (hostname.includes(reg.hostIncludes) || jobUrl.includes(reg.hostIncludes)) {
        return reg.adapter;
      }
    }

    // Additional ATS domain checks can be registered here in the future
    for (const adapter of adapters) {
      if (hostname.includes(adapter.name.toLowerCase())) {
        return adapter;
      }
    }
  } catch {
    // If URL parsing fails, check substring matches
    for (const reg of registeredAdapters) {
      if (jobUrl.includes(reg.hostIncludes)) {
        return reg.adapter;
      }
    }
    if (jobUrl.includes("lever.co")) {
      const adapter = adapters.find((a) => a.name === "lever");
      if (adapter) return adapter;
    }
    if (jobUrl.includes("greenhouse.io")) {
      const adapter = adapters.find((a) => a.name === "greenhouse");
      if (adapter) return adapter;
    }
  }

  throw new Error(`Unsupported ATS for URL: ${jobUrl}`);
}
