import { readFileSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { browserKey, browsersRoot, stateDir, stateFile } from "./paths.js";

const SPACES_FILE = "spaces.json";
const BROWSERS_FILE = "browsers.json";

export async function readJsonFile(file, fallback) {
  try {
    const raw = await readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export async function writeJsonFile(file, value) {
  await mkdir(stateDir(), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, file);
}

/**
 * Cross-process mutex for the shared state files and for "launch Chrome once".
 * The CLI is short-lived, so a small polling lock is enough; stale locks left by
 * a killed process are reclaimed after `staleMs`.
 */
export async function withLock(name, operation, { timeoutMs = 20000, staleMs = 60000 } = {}) {
  const file = stateFile(`.${name}.lock`);
  await mkdir(stateDir(), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let handle;
  while (!handle) {
    try {
      handle = await open(file, "wx");
      await handle.writeFile(String(process.pid));
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const info = await stat(file).catch(() => null);
      if (info && Date.now() - info.mtimeMs > staleMs) {
        await unlink(file).catch(() => {});
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for the rook state lock (${name})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25 + Math.floor(Math.random() * 25)));
    }
  }
  try {
    return await operation();
  } finally {
    await handle.close().catch(() => {});
    await unlink(file).catch(() => {});
  }
}

export async function loadSpaces() {
  const state = await readJsonFile(stateFile(SPACES_FILE), null);
  if (!state || !Array.isArray(state.spaces)) {
    return { version: 1, nextId: 1, spaces: [] };
  }
  if (!Number.isInteger(state.nextId) || state.nextId < 1) state.nextId = 1;
  return state;
}

/** Synchronous variant: useTaskSpace() must resolve the space before it returns. */
export function loadSpacesSync() {
  try {
    const state = JSON.parse(readFileSync(stateFile(SPACES_FILE), "utf8"));
    if (state && Array.isArray(state.spaces)) {
      if (!Number.isInteger(state.nextId) || state.nextId < 1) state.nextId = 1;
      return state;
    }
  } catch {
    // Missing or unreadable state: start from empty.
  }
  return { version: 1, nextId: 1, spaces: [] };
}

export async function saveSpaces(state) {
  state.updatedAt = Date.now();
  await writeJsonFile(stateFile(SPACES_FILE), state);
}

export async function updateSpaces(mutate) {
  return withLock("spaces", async () => {
    const state = await loadSpaces();
    const result = await mutate(state);
    await saveSpaces(state);
    return result;
  });
}

export async function loadBrowsers() {
  const state = await readJsonFile(stateFile(BROWSERS_FILE), null);
  if (!state || typeof state.browsers !== "object" || state.browsers === null) {
    return { version: 1, browsers: {} };
  }
  return state;
}

export async function saveBrowsers(state) {
  await writeJsonFile(stateFile(BROWSERS_FILE), state);
}

const DEFAULT_PROFILE = { id: "Default", name: "Default", isDefault: true };

/**
 * Profiles are directories of seeded Chromium user-data dirs. A fresh state dir
 * exposes only the default profile; extra directories appear as profiles once
 * they hold a Chromium profile (stage 2's shell can seed them).
 */
export async function listProfiles() {
  let entries = [];
  try {
    entries = await readdir(browsersRoot(), { withFileTypes: true });
  } catch {
    entries = [];
  }
  const prefix = `${browserKey()}-`;
  const profiles = [DEFAULT_PROFILE];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const id = entry.name.slice(prefix.length);
    if (!id || id === DEFAULT_PROFILE.id) continue;
    const info = await stat(join(browsersRoot(), entry.name, "chrome")).catch(() => null);
    if (!info?.isDirectory()) continue;
    profiles.push({ id, name: id, isDefault: false });
  }
  return profiles;
}

export async function resolveProfile(profileId) {
  const profiles = await listProfiles();
  const wanted =
    typeof profileId === "string" && profileId.trim() !== "" && profileId !== "default"
      ? profileId
      : null;
  if (!wanted) return profiles.find((profile) => profile.isDefault) ?? profiles[0];
  return profiles.find((profile) => profile.id === wanted) ?? null;
}
