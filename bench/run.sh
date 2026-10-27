#!/usr/bin/env bash
# The benchmark behind bench/report.md.
#
#   bench/run.sh                # unpack the newest .deb, measure, write results.json
#   bench/run.sh --report       # also regenerate report.md and report.html
#   bench/run.sh --force        # re-extract even if work/root is already there
#   ROOK_BENCH_QUICK=1 bench/run.sh --report   # short windows, for a smoke test
#
# Nothing is installed system-wide and nothing needs root: the .deb is extracted
# with `dpkg-deb -x` into bench/work/root and run from there, the same way
# packaging/verify-deb.sh does it. A private Xvfb per measured run keeps this
# off :99, which other QA runs on this box share.
set -uo pipefail

bench_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$bench_dir/.." && pwd)"
work="$bench_dir/work"
root="$work/root"
app="$root/usr/bin/rook"
report=0
force=0

for arg in "$@"; do
  case "$arg" in
    --report) report=1 ;;
    --force) force=1 ;;
    -h|--help)
      sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "run.sh: unknown argument $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m[bench]\033[0m %s\n' "$*"; }
die() { printf '\n\033[1m[bench] FAIL\033[0m %s\n' "$*" >&2; exit 1; }

# --- interpreter ------------------------------------------------------------
node_bin="${ROOK_NODE:-}"
if [ -z "$node_bin" ]; then
  # /tmp/opencode/node22 is the Node 22 this box keeps for the bridge; a distro
  # node is usually 18, which cannot run it at all.
  for candidate in "$(command -v node 2>/dev/null)" /tmp/opencode/node22/bin/node /usr/local/bin/node22 /opt/node22/bin/node; do
    [ -n "$candidate" ] && [ -x "$candidate" ] || continue
    major=$("$candidate" -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)
    if [ "${major:-0}" -ge 22 ] 2>/dev/null; then node_bin="$candidate"; break; fi
  done
fi
[ -n "$node_bin" ] || die "needs Node.js >= 22 (the bridge uses the built-in WebSocket); set ROOK_NODE"

for tool in dpkg-deb python3 xdpyinfo getconf; do
  command -v "$tool" >/dev/null 2>&1 || die "missing tool: $tool"
done

# --- package ----------------------------------------------------------------
deb="${ROOK_BENCH_DEB:-$(ls -t "$repo_dir"/packaging/out/rook_*.deb 2>/dev/null | head -1)}"
[ -n "$deb" ] && [ -f "$deb" ] || die "no .deb in packaging/out (build one first, or set ROOK_BENCH_DEB)"

say "package"
printf '  %-14s %s\n' "deb" "$deb"
printf '  %-14s %s\n' "size" "$(du -h "$deb" | cut -f1)"
printf '  %-14s %s\n' "installed" "$(dpkg-deb -f "$deb" Installed-Size | awk '{ printf "%.0f MB", $1 * 1024 / 1000000 }')"

stamp="$work/.deb-stamp"
current="$(stat -c '%Y:%s' "$deb")"
if [ "$force" = 1 ] || [ ! -x "$app" ] || [ "$(cat "$stamp" 2>/dev/null)" != "$current" ]; then
  say "extract (dpkg-deb -x, no install)"
  rm -rf "$root"
  mkdir -p "$root"
  dpkg-deb -x "$deb" "$root" || die "dpkg-deb -x failed"
  printf '%s' "$current" > "$stamp"
  printf '  %-14s %s\n' "payload" "$(du -sh "$root/usr/lib/rook" | cut -f1)"
else
  say "reuse unpacked package ($(cat "$stamp" 2>/dev/null))"
fi
[ -x "$app" ] || die "the unpacked package has no $app"

# --- environment ------------------------------------------------------------
say "environment"
printf '  %-14s %s\n' "cores" "$(nproc)"
printf '  %-14s %s\n' "node" "$("$node_bin" -v)"
printf '  %-14s %s\n' "clk_tck" "$(getconf CLK_TCK)"
printf '  %-14s %s\n' "load" "$(cut -d' ' -f1-3 /proc/loadavg)"
if [ -n "${ROOK_BENCH_XVFB:-}" ] && [ ! -x "$ROOK_BENCH_XVFB" ]; then
  die "ROOK_BENCH_XVFB=$ROOK_BENCH_XVFB is not executable"
fi
xvfb="${ROOK_BENCH_XVFB:-}"
if [ -z "$xvfb" ]; then
  if [ -x /tmp/opencode/xvfb-root/usr/bin/Xvfb ]; then xvfb=/tmp/opencode/xvfb-root/usr/bin/Xvfb
  else xvfb="$(command -v Xvfb || true)"; fi
fi
[ -n "$xvfb" ] && { [ -x "$xvfb" ] || command -v "$xvfb" >/dev/null 2>&1; } ||
  die "no Xvfb: install xvfb, or set ROOK_BENCH_XVFB=/path/to/Xvfb"

# --- measure ----------------------------------------------------------------
say "measuring (a full pass takes about ten minutes)"
start=$(date +%s)
"$node_bin" "$bench_dir/bench.mjs"
status=$?
elapsed=$(( $(date +%s) - start ))
say "done in $((elapsed / 60))m $((elapsed % 60))s"

if [ "$report" = 1 ] || [ ! -f "$bench_dir/report.md" ]; then
  "$node_bin" "$bench_dir/report.mjs" || die "report generation failed"
fi

if [ "$status" -ne 0 ]; then
  printf '\n\033[1m[bench]\033[0m one or more targets are not met; see bench/report.md\n'
fi
exit "$status"
