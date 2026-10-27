import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Locate a syntax error that Node's dynamic import() refused to place.
 *
 * `await import(broken.mjs)` rejects with a SyntaxError whose message is just
 * "Unexpected token ';'" — ESM compile errors carry no `file:line` in either
 * `message` or `stack`. `node --check` parses the same file with the same
 * engine (top-level await included) and prints the location, so the launcher
 * asks it only after a round has already failed.
 *
 * Returns null when the file parses cleanly (the original error is then more
 * accurate than anything we could print).
 */
export async function explainSyntaxError(scriptPath, source) {
  let stderr = "";
  try {
    await run(process.execPath, ["--check", scriptPath], { timeout: 15000 });
    return null;
  } catch (error) {
    stderr = String(error?.stderr ?? "");
  }
  const location = parseCheckOutput(stderr);
  if (!location) return null;

  const lines = String(source ?? "").split(/\r?\n/);
  const sourceLine = location.sourceLine || lines[location.line - 1] || "";
  const gutter = String(location.line);
  const caret = " ".repeat(gutter.length + 3 + Math.max(0, location.column - 1));
  return [
    `ego-browser: script syntax error at line ${location.line}, column ${location.column}`,
    `${gutter} | ${sourceLine}`,
    `${caret}^`,
    location.reason,
  ].join("\n");
}

/**
 * `node --check` writes, on failure:
 *
 *   /path/to/round-123.mjs:2
 *   const y = ;
 *             ^
 *
 *   SyntaxError: Unexpected token ';'
 *       at checkSyntax (node:internal/main/check_syntax:74:5)
 */
function parseCheckOutput(stderr) {
  const lines = stderr.split("\n");
  const headerIndex = lines.findIndex((line) => /:\d+\s*$/.test(line));
  if (headerIndex < 0) return null;
  const header = lines[headerIndex];
  const line = Number(header.slice(header.lastIndexOf(":") + 1));
  if (!Number.isInteger(line) || line <= 0) return null;

  const sourceLine = lines[headerIndex + 1] ?? "";
  const caretLine = lines[headerIndex + 2] ?? "";
  const caretIndex = caretLine.indexOf("^");
  const reason =
    lines
      .slice(headerIndex + 3)
      .map((entry) => entry.trim())
      .find((entry) => /^[A-Za-z]*Error\b/.test(entry)) ?? "SyntaxError";

  return {
    line,
    column: caretIndex >= 0 ? caretIndex + 1 : 1,
    sourceLine,
    reason,
  };
}
