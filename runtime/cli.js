import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createEgoRuntime } from "./bridge.js";
import { shutdownBrowsers } from "./browser.js";
import { hostSocketPaths, resolveSelection } from "./backends/index.js";
import { explainSyntaxError } from "./syntax.js";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const HELP = `ego-browser (Linux runtime)

Usage:
  ego-browser nodejs [--sdk-path <index.js>] [-e <script>] [--standalone]
      Run an ego-browser script. The script comes from -e, or from stdin.
      Without --sdk-path the SDK comes from EGO_BROWSER_SDK_PATH.
      --standalone ignores a running Rook app and drives Chrome itself
      (headless, unless ROOK_HEADFUL=1 asks for a real window).

  ego-browser skill [--sdk-path <index.js>]
      Print the usage guide that belongs to the resolved SDK.

  ego-browser shutdown
      Stop the Chrome processes this state directory started (the native app,
      if one is running, is not touched).

  ego-browser backend
      Print which browser backend this environment would use, and why.

Backend selection: the native app's control socket is used when the app is
running, otherwise Chrome (never both). ROOK_BACKEND=host|standalone
forces one; --standalone is the same as ROOK_BACKEND=standalone.

Examples:
  ego-browser nodejs <<'JS'
  const task = await taskSpace("demo")
  const page = task.page("p1")
  await page.goto("https://example.com")
  console.log(await page.snapshot())
  JS

  ego-browser nodejs --sdk-path /path/to/dist/out/index.js -e 'console.log(1)'
`;

function parseArgv(argv) {
  const options = {
    command: null,
    sdkPath: undefined,
    code: undefined,
    help: false,
    standalone: false,
  };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (arg === "--standalone") {
      options.standalone = true;
    } else if (arg === "--sdk-path") {
      options.sdkPath = argv[++index];
    } else if (arg.startsWith("--sdk-path=")) {
      options.sdkPath = arg.slice("--sdk-path=".length);
    } else if (arg === "-e" || arg === "--eval") {
      options.code = argv[++index];
    } else if (arg.startsWith("--eval=")) {
      options.code = arg.slice("--eval=".length);
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  options.command = positional[0] ?? "nodejs";
  if (positional.length > 1) {
    throw new Error(`unexpected argument ${positional[1]}`);
  }
  return options;
}

function resolveSdkPath(configured) {
  const candidate =
    configured ||
    process.env.EGO_BROWSER_SDK_PATH ||
    join(PACKAGE_ROOT, "dist", "out", "index.js");
  if (!candidate) {
    throw new Error(
      "No SDK found. Pass --sdk-path /path/to/dist/out/index.js or set EGO_BROWSER_SDK_PATH.",
    );
  }
  if (!existsSync(candidate)) {
    throw new Error(
      `SDK not found at ${candidate}. Build the ego-browser checkout (npm ci && npm run build) and pass --sdk-path dist/out/index.js, or set EGO_BROWSER_SDK_PATH.`,
    );
  }
  return candidate;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function roundDirectory() {
  return join(tmpdir(), "rook-rounds");
}

/**
 * Write the round script into a scratch directory, sweeping scripts a killed
 * round left behind. A SIGKILLed or timed-out run never reaches its unlink, and
 * agent scripts should not accumulate in /tmp.
 */
async function prepareRoundDirectory() {
  const directory = roundDirectory();
  await mkdir(directory, { recursive: true });
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const entries = await readdir(directory).catch(() => []);
  for (const entry of entries) {
    if (!entry.startsWith("round-") || !entry.endsWith(".mjs")) continue;
    const info = await stat(join(directory, entry)).catch(() => null);
    if (info && info.mtimeMs < cutoff) {
      await unlink(join(directory, entry)).catch(() => {});
    }
  }
  return directory;
}

function scrubScriptPath(error, scriptPath) {
  const text = String(error?.stack || error?.message || error);
  if (!scriptPath) return text;
  return text.split(scriptPath).join("script.mjs");
}

async function runNodejs(options) {
  const sdkPath = resolveSdkPath(options.sdkPath);
  const source =
    options.code !== undefined ? options.code : await readStdin();
  if (options.code !== undefined) process.stdin.unref?.();
  if (!String(source ?? "").trim()) {
    process.stderr.write("ego-browser: no script provided on stdin or with -e\n");
    return 2;
  }

  const ego = createEgoRuntime({
    backend: options.standalone ? "standalone" : undefined,
  });
  Object.defineProperty(globalThis, "ego", {
    value: ego,
    writable: true,
    configurable: true,
    enumerable: true,
  });

  await import(pathToFileURL(sdkPath).href);

  const directory = await prepareRoundDirectory();
  const scriptPath = join(directory, `round-${process.pid}-${Date.now()}.mjs`);
  await writeFile(scriptPath, source, "utf8");

  try {
    await import(pathToFileURL(scriptPath).href);
  } catch (error) {
    if (error instanceof SyntaxError) {
      const explained = await explainSyntaxError(scriptPath, source);
      process.stderr.write(
        `${explained ?? `ego-browser: script syntax error: ${error.message}`}\n`,
      );
    } else {
      process.stderr.write(`${scrubScriptPath(error, scriptPath)}\n`);
    }
    return 1;
  } finally {
    await unlink(scriptPath).catch(() => {});
    await ego.dispose().catch(() => {});
  }
  return 0;
}

async function runSkill(options) {
  const sdkPath = resolveSdkPath(options.sdkPath);
  const guideDirectory = join(dirname(sdkPath), "ego-browser");
  const guidePath = join(guideDirectory, "SKILL.md");
  if (!existsSync(guidePath)) {
    throw new Error(
      `skill guide missing: ${guidePath} (expected beside the SDK at ${sdkPath})`,
    );
  }
  const text = await readFile(guidePath, "utf8");
  if (options.sdkPath || process.env.EGO_BROWSER_SDK_PATH) {
    const source = options.sdkPath ? "sdk-path" : "env";
    process.stdout.write(
      `[ego-browser:skill] source=${source} dir=${guideDirectory} (override, not the bundled guide)\n`,
    );
  }
  process.stdout.write(text);
  return 0;
}

async function runShutdown() {
  const stopped = await shutdownBrowsers();
  process.stdout.write(
    stopped.length === 0
      ? "ego-browser: no running browser processes\n"
      : `ego-browser: stopped browser for ${stopped.join(", ")}\n`,
  );
  return 0;
}

/** `ego-browser backend`: which route this environment would take. */
async function runBackend(options) {
  const requested = options.standalone ? "standalone" : undefined;
  const chosen = await resolveSelection({ requested });
  const paths = hostSocketPaths();
  process.stdout.write(
    `backend: ${chosen.mode} (${chosen.source})\n` +
      (chosen.socketPath ? `socket:  ${chosen.socketPath}\n` : "") +
      `looked for: ${paths.join(", ")}\n`,
  );
  return 0;
}

async function main(argv) {
  let options;
  try {
    options = parseArgv(argv);
  } catch (error) {
    process.stderr.write(`ego-browser: ${error.message}\n\n${HELP}`);
    return 2;
  }
  if (options.help || options.command === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  try {
    if (options.command === "nodejs" || options.command === "") {
      return await runNodejs(options);
    }
    if (options.command === "skill") return await runSkill(options);
    if (options.command === "shutdown") return await runShutdown();
    if (options.command === "backend") return await runBackend(options);
    process.stderr.write(`ego-browser: unknown command ${options.command}\n\n${HELP}`);
    return 2;
  } catch (error) {
    process.stderr.write(`ego-browser: ${error?.message || error}\n`);
    return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`ego-browser: ${error?.stack || error}\n`);
    process.exitCode = 1;
  },
);
