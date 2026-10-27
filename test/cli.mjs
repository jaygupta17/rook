/**
 * Launcher-surface test: argument handling, exit codes, stdin vs -e, the
 * syntax diagnostic, `skill` and `shutdown`.
 *
 *   node test/cli.mjs
 *
 * Needs no browser: the scripts here never touch `ego`, so a two-line stub
 * stands in for the upstream SDK. Run the smoke test for the real thing.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(dirname(HERE), "bin", "ego-browser");
const GUIDE = "# Stub usage guide\n\nThis guide pretends to be the ego-browser skill.\n";

let failures = 0;
let checks = 0;

function check(condition, message, detail) {
  checks += 1;
  if (condition) return;
  failures += 1;
  console.error(` - ${message}${detail ? `\n${detail}` : ""}`);
}

function run(args, { input = "", env = {} } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(CLI, args, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), "rook-cli-"));
  const stateDir = join(root, "state");
  const sdkDir = join(root, "sdk");
  const sdkPath = join(sdkDir, "index.js");
  await mkdir(join(sdkDir, "ego-browser"), { recursive: true });
  await writeFile(sdkPath, "export const stub = true;\n", "utf8");
  await writeFile(join(sdkDir, "ego-browser", "SKILL.md"), GUIDE, "utf8");
  const bareDir = join(root, "bare");
  await mkdir(bareDir, { recursive: true });
  const bareSdkPath = join(bareDir, "index.js");
  await writeFile(bareSdkPath, "export {};\n", "utf8");

  const env = { EGO_BROWSER_STATE_DIR: stateDir };

  // -- help ---------------------------------------------------------------
  for (const args of [["--help"], ["-h"], ["help"]]) {
    const result = await run(args, { env });
    check(result.code === 0, `${args.join(" ")} exits 0`, result.stderr);
    check(
      result.stdout.includes("ego-browser") && result.stdout.includes("--sdk-path"),
      `${args.join(" ")} prints usage`,
      result.stdout,
    );
  }

  // -- nodejs -e and stdin ------------------------------------------------
  const evalResult = await run(["nodejs", "--sdk-path", sdkPath, "-e", "console.log(1 + 1)"], {
    env,
  });
  check(evalResult.code === 0, "nodejs -e exits 0", evalResult.stderr);
  check(evalResult.stdout.trim() === "2", "nodejs -e runs the script", evalResult.stdout);

  const stdinResult = await run(["nodejs", "--sdk-path", sdkPath], {
    env,
    input: "console.log('from stdin')\n",
  });
  check(stdinResult.code === 0, "nodejs stdin exits 0", stdinResult.stderr);
  check(
    stdinResult.stdout.includes("from stdin"),
    "nodejs reads the script from stdin",
    stdinResult.stdout,
  );

  const emptyResult = await run(["nodejs", "--sdk-path", sdkPath], { env, input: "  \n" });
  check(emptyResult.code === 2, "empty script exits 2", String(emptyResult.code));
  check(
    emptyResult.stderr.includes("no script provided"),
    "empty script explains why",
    emptyResult.stderr,
  );

  // -- failures -----------------------------------------------------------
  const thrown = await run(
    ["nodejs", "--sdk-path", sdkPath, "-e", "throw new Error('boom from script')"],
    { env },
  );
  check(thrown.code === 1, "throwing script exits 1", String(thrown.code));
  check(
    thrown.stderr.includes("boom from script"),
    "throwing script reports its message",
    thrown.stderr,
  );
  check(
    !thrown.stderr.includes(root) && thrown.stderr.includes("script.mjs"),
    "throwing script hides the temp path",
    thrown.stderr,
  );

  for (const [label, source, line, column] of [
    ["single line", "const x = ;\n", 1, 11],
    ["top-level await", "await Promise.resolve(1)\nconst y = ;\n", 2, 11],
  ]) {
    const result = await run(["nodejs", "--sdk-path", sdkPath, "-e", source], { env });
    check(result.code === 1, `syntax error (${label}) exits 1`, String(result.code));
    check(
      result.stderr.includes(`script syntax error at line ${line}, column ${column}`),
      `syntax error (${label}) reports line and column`,
      result.stderr,
    );
    check(
      /^\s*\^$/m.test(result.stderr.split("\n")[2] ?? ""),
      `syntax error (${label}) prints a caret line`,
      result.stderr,
    );
    check(
      result.stderr.includes("SyntaxError"),
      `syntax error (${label}) names the error`,
      result.stderr,
    );
  }

  // -- argument errors ----------------------------------------------------
  const unknownOption = await run(["nodejs", "--nope"], { env });
  check(unknownOption.code === 2, "unknown option exits 2", String(unknownOption.code));
  check(
    unknownOption.stderr.includes("unknown option --nope"),
    "unknown option is named",
    unknownOption.stderr,
  );

  const unknownCommand = await run(["bogus"], { env });
  check(unknownCommand.code === 2, "unknown command exits 2", String(unknownCommand.code));
  check(
    unknownCommand.stderr.includes("unknown command bogus"),
    "unknown command is named",
    unknownCommand.stderr,
  );

  const missingSdk = await run(["nodejs", "-e", "console.log(1)"], {
    env: { ...env, EGO_BROWSER_SDK_PATH: "" },
  });
  check(missingSdk.code === 1, "missing SDK exits 1", String(missingSdk.code));
  check(
    missingSdk.stderr.includes("SDK not found") && missingSdk.stderr.includes("EGO_BROWSER_SDK_PATH"),
    "missing SDK says how to fix it",
    missingSdk.stderr,
  );

  // -- skill --------------------------------------------------------------
  const skill = await run(["skill", "--sdk-path", sdkPath], { env });
  check(skill.code === 0, "skill exits 0", skill.stderr);
  const skillLines = skill.stdout.split("\n");
  check(
    skillLines[0].startsWith("[ego-browser:skill] source=sdk-path"),
    "skill announces an override",
    skillLines[0],
  );
  check(
    skill.stdout.slice(skillLines[0].length + 1) === GUIDE,
    "skill prints the guide unchanged after the override line",
    skill.stdout,
  );

  const skillFromEnv = await run(["skill"], {
    env: { ...env, EGO_BROWSER_SDK_PATH: sdkPath },
  });
  check(skillFromEnv.code === 0, "skill honours EGO_BROWSER_SDK_PATH", skillFromEnv.stderr);
  check(
    skillFromEnv.stdout.startsWith("[ego-browser:skill] source=env"),
    "skill labels an env override",
    skillFromEnv.stdout.split("\n")[0],
  );

  const skillMissingGuide = await run(["skill", "--sdk-path", bareSdkPath], { env });
  check(skillMissingGuide.code === 1, "skill without a guide exits 1", String(skillMissingGuide.code));
  check(
    skillMissingGuide.stderr.includes("skill guide missing") &&
      skillMissingGuide.stderr.includes(join("bare", "ego-browser", "SKILL.md")),
    "skill names the guide path it checked",
    skillMissingGuide.stderr,
  );

  const skillExtraArg = await run(["skill", "extra"], { env });
  check(skillExtraArg.code === 2, "skill with an extra argument exits 2", String(skillExtraArg.code));
  check(skillExtraArg.stderr.includes("unexpected argument extra"), "skill names the extra argument");

  // -- backend selection --------------------------------------------------
  // Point the probe at a socket that cannot exist, so a native app that happens
  // to be running on this machine can never change the outcome.
  const offline = {
    ...env,
    ROOK_BACKEND: "",
    ROOK_HOST_SOCKET: join(root, "no-such-socket.sock"),
  };
  const autoBackend = await run(["backend"], { env: offline });
  check(autoBackend.code === 0, "backend exits 0", autoBackend.stderr);
  check(
    /backend: standalone \(auto\)/.test(autoBackend.stdout),
    "backend reports the standalone fallback",
    autoBackend.stdout,
  );
  check(
    autoBackend.stdout.includes(join(root, "no-such-socket.sock")),
    "backend names the socket it looked for",
    autoBackend.stdout,
  );

  const forcedBackend = await run(["backend", "--standalone"], { env: offline });
  check(
    /backend: standalone \(flag\)/.test(forcedBackend.stdout),
    "--standalone wins over auto-detection",
    forcedBackend.stdout,
  );

  const hostBackend = await run(["backend"], {
    env: { ...offline, ROOK_BACKEND: "host" },
  });
  check(
    /backend: host \(env\)/.test(hostBackend.stdout),
    "ROOK_BACKEND=host is honoured",
    hostBackend.stdout,
  );

  const badBackend = await run(["backend"], {
    env: { ...offline, ROOK_BACKEND: "nope" },
  });
  check(badBackend.code === 1, "an unknown ROOK_BACKEND exits 1", String(badBackend.code));
  check(
    badBackend.stderr.includes("ROOK_BACKEND must be"),
    "an unknown ROOK_BACKEND says what the values are",
    badBackend.stderr,
  );

  const standaloneRun = await run(
    ["nodejs", "--standalone", "--sdk-path", sdkPath, "-e", "console.log('ran standalone')"],
    { env: offline },
  );
  check(standaloneRun.code === 0, "nodejs --standalone runs a script", standaloneRun.stderr);
  check(
    standaloneRun.stdout.includes("ran standalone"),
    "nodejs --standalone runs the given code",
    standaloneRun.stdout,
  );

  // -- shutdown -----------------------------------------------------------
  const shutdown = await run(["shutdown"], { env });
  check(shutdown.code === 0, "shutdown exits 0", shutdown.stderr);
  check(
    shutdown.stdout.includes("no running browser processes"),
    "shutdown reports an empty state",
    shutdown.stdout,
  );

  // -- scratch scripts ----------------------------------------------------
  const rounds = join(tmpdir(), "rook-rounds");
  await mkdir(rounds, { recursive: true });
  const stale = join(rounds, "round-stale-fixture.mjs");
  await writeFile(stale, "console.log('stale')\n", "utf8");
  const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await utimes(stale, twoDaysAgo, twoDaysAgo);
  const sweep = await run(["nodejs", "--sdk-path", sdkPath, "-e", "console.log('swept')"], { env });
  check(sweep.code === 0, "a round after a kill still runs", sweep.stderr);
  check(!existsSync(stale), "day-old round scripts are swept");

  await rm(root, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`\nCLI FAILED (${failures} of ${checks} checks)`);
    process.exitCode = 1;
    return;
  }
  console.log(`CLI PASSED (${checks} checks)`);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
