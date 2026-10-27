import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

/** An XDG base directory: the env var when set, else <home>/<fallback>. */
function xdg(envVar, ...fallback) {
  const configured = process.env[envVar];
  if (typeof configured === "string" && configured.trim() !== "") {
    return configured.trim();
  }
  return join(homedir(), ...fallback);
}

/**
 * Resolve the state directory lazily: agent scripts set EGO_BROWSER_STATE_DIR
 * (and the E2E suite does exactly that) after the process has started but
 * before the first task-space call.
 */
export function stateDir() {
  const configured = process.env.EGO_BROWSER_STATE_DIR;
  if (typeof configured === "string" && configured.trim() !== "") {
    return configured.trim();
  }
  return join(xdg("XDG_CONFIG_HOME", ".config"), "rook", "state");
}

export function stateFile(name) {
  return join(stateDir(), name);
}

/** Machine-wide root for durable browser profiles (not the per-run state dir). */
export function runtimeHome() {
  const configured = process.env.ROOK_HOME;
  if (typeof configured === "string" && configured.trim() !== "") {
    return configured.trim();
  }
  return join(xdg("XDG_STATE_HOME", ".local", "state"), "rook");
}

export function browserKey() {
  return createHash("sha1").update(stateDir()).digest("hex").slice(0, 12);
}

export function browsersRoot() {
  return join(runtimeHome(), "browsers");
}

/**
 * Chromium's user-data-dir. It must NOT live inside EGO_BROWSER_STATE_DIR: the
 * E2E suite deletes that directory at cleanup while the browser daemon is still
 * writing into its profile, which turns cleanup into ENOTEMPTY.
 */
export function profileDataDir(profileId) {
  return join(browsersRoot(), `${browserKey()}-${profileId}`, "chrome");
}

/** Chrome binary; ROOK_CHROME wins so tests and the desktop shell can override. */
export function chromeBinary() {
  const configured = process.env.ROOK_CHROME;
  if (typeof configured === "string" && configured.trim() !== "") {
    return configured.trim();
  }
  return "/usr/bin/google-chrome";
}
