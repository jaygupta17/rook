#!/usr/bin/env bash
# Verify a built .deb without installing it.
#
# Five checks, because "it unpacked" proves nothing about a browser payload:
#   1. metadata and file modes out of the archive itself (dpkg-deb -I / -c),
#   2. layout after `dpkg-deb -x` into a throwaway root,
#   3. the unpacked launcher renders a real page headlessly, and the window is
#      painted by the *packaged* libcef.so (checked in /proc/<pid>/maps),
#   4. every soname the two binaries link against is covered by Depends.
#   5. the licence texts of every bundled third party are in the archive and
#      contain what they are supposed to contain.
#
#   packaging/verify-deb.sh                       # newest deb in packaging/out
#   packaging/verify-deb.sh path/to/file.deb
#   ROOK_DISPLAY=:98 packaging/verify-deb.sh
#
# Nothing here needs root: no install, no setuid, no sudo.
set -uo pipefail

pkg_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$pkg_dir/.." && pwd)"
work="$pkg_dir/work/verify"
display="${ROOK_DISPLAY:-:99}"

deb="${1:-}"
if [ -z "$deb" ]; then
  deb=$(ls -t "$pkg_dir"/out/rook_*.deb 2>/dev/null | head -1)
fi
[ -n "$deb" ] && [ -f "$deb" ] || { echo "no .deb to verify (build one first)" >&2; exit 2; }

say()  { printf '\n\033[1m[verify]\033[0m %s\n' "$*"; }
human() { du -sk "$1" 2>/dev/null | awk '{ k=$1; if (k >= 1000) printf "%.1f MB", k*1.024/1000; else printf "%d KB", k }'; }
mb() { awk -v b="$1" 'BEGIN { printf "%.0f MB", b/1000000 }'; }
step() { printf '  %-20s %s\n' "$1" "$2"; }
fail() { printf '\n\033[1m[verify] FAIL\033[0m %s\n' "$*" >&2; exit 1; }
ok()   { printf '  %-20s %s\n' "$1" "$2"; }
warn() { printf '\033[1m[verify] note\033[0m %s\n' "$*" >&2; }

for tool in dpkg-deb python3 identify xdpyinfo; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing tool: $tool"
done

root="$work/root"
server_pid=""; app_pid=""; xvfb_pid=""
cleanup() {
  [ -n "$app_pid" ] && kill "$app_pid" 2>/dev/null
  [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null
  [ -n "$xvfb_pid" ] && kill "$xvfb_pid" 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT

rm -rf "$work"; mkdir -p "$work"

say "archive"
step "file" "$deb"
step "size" "$(mb "$(stat -c %s "$deb")") ($(stat -c %s "$deb") bytes)"

# --- 1. metadata -------------------------------------------------------------
echo
for field in Package Version Architecture Section Priority Installed-Size; do
  printf '  %-16s %s\n' "$field:" "$(dpkg-deb -f "$deb" "$field")"
done
printf '  %-16s %s\n' "Depends:" "$(dpkg-deb -f "$deb" Depends | tr -s ' \n' ' ')"
printf '  %-16s %s\n' "Description:" "$(dpkg-deb -f "$deb" Description | head -1)"

# A package can be current in name only: the 0.3.0~m3 build that this release
# replaces was built before the space-id and focus fixes, so "Version:" alone
# proves nothing. Check that the name, the field and the string the app prints
# are one release, with no milestone suffix to sort a milestone below a final.
deb_version=$(dpkg-deb -f "$deb" Version)
case "$deb_version" in
  *"~"*|*-M[0-9]*) fail "Version $deb_version carries a milestone suffix; a release is named after the release" ;;
esac
case "$(basename "$deb")" in
  "rook_${deb_version}_"*.deb) ok "name" "matches Version $deb_version (no ~m suffix)" ;;
  *) fail "file name $(basename "$deb") does not match Version $deb_version" ;;
esac

files=$(dpkg-deb -c "$deb")
n_entries=$(printf '%s\n' "$files" | wc -l | tr -d ' ')
n_links=$(printf '%s\n' "$files" | awk '$1 ~ /^l/' | wc -l | tr -d ' ')
payload_kb=$(printf '%s\n' "$files" | awk '$1 !~ /^d/ && $1 !~ /^l/ {s+=$3} END {printf "%d", s/1024}')
step "entries" "$n_entries ($((n_entries - n_links)) files, $n_links symlinks)"
step "payload" "${payload_kb} KiB of file data, $(mb "$(stat -c %s "$deb")") archive"

# --- 2. modes ----------------------------------------------------------------
sandbox_line=$(printf '%s\n' "$files" | grep 'cef/chrome-sandbox$' || true)
[ -n "$sandbox_line" ] || fail "chrome-sandbox is not in the archive"
sandbox_mode=$(printf '%s' "$sandbox_line" | awk '{print $1}')
case "$sandbox_mode" in
  -rwsr-xr-x|rwsr-xr-x) ok "chrome-sandbox" "$sandbox_mode root/root (setuid)" ;;
  *) fail "chrome-sandbox mode is $sandbox_mode, expected 4755" ;;
esac
[ "$(printf '%s' "$sandbox_line" | awk '{print $2}')" = "root/root" ] ||
  fail "chrome-sandbox owner is not root/root"

for launcher in usr/bin/rook usr/bin/ego-browser; do
  line=$(printf '%s\n' "$files" | grep " \./$launcher$" || true)
  [ -n "$line" ] || fail "$launcher missing"
  mode=$(printf '%s' "$line" | awk '{print $1}')
  case "$mode" in
    -rwxr-xr-x) ok "$launcher" "$mode" ;;
    *) fail "$launcher mode is $mode, expected 0755" ;;
  esac
done

# The host binary must be executable and not setuid (only the helper is).
line=$(printf '%s\n' "$files" | grep " \./usr/lib/rook/rook$" || true)
[ -n "$line" ] || fail "usr/lib/rook/rook missing"
mode=$(printf '%s' "$line" | awk '{print $1}')
[ "$mode" = "-rwxr-xr-x" ] || fail "host binary mode is $mode"
ok "rook" "$mode"

# --- 3. extraction -----------------------------------------------------------
say "extract (dpkg-deb -x, no install)"
dpkg-deb -x "$deb" "$root" || fail "dpkg-deb -x failed"
libdir="$root/usr/lib/rook"
for f in rook node runtime/cli.js cef/libcef.so cef/icudtl.dat cef/resources.pak \
         cef/v8_context_snapshot.bin cef/locales/en-US.pak; do
  [ -e "$libdir/$f" ] || fail "missing from extraction: usr/lib/rook/$f"
done
ok "payload" "$(human "$libdir") in $root"
ok "locales" "$(ls "$libdir/cef/locales" | tr '\n' ' ')"
# Informational: extracting as a normal user cannot restore root ownership, so
# the on-disk mode here is not the mode dpkg will install. The archive check
# above is the authoritative one.
step "sandbox on disk" "$(stat -c '%a %U:%G' "$libdir/cef/chrome-sandbox") after extraction as $(id -un)"

# The whole point of staging: the packaged libcef.so is the stripped one.
ok "libcef.so" "$(mb "$(stat -c %s "$libdir/cef/libcef.so")") (stripped), $(file -b "$libdir/cef/libcef.so" | cut -c1-52)"
[ "$(readelf -d "$libdir/rook" | grep -o '\$ORIGIN/cef')" = '$ORIGIN/cef' ] ||
  fail "host binary rpath is not \$ORIGIN/cef"
ok "rpath" "\$ORIGIN/cef ($(readelf -d "$libdir/rook" | grep -oE '(RPATH|RUNPATH)' | head -1))"

# What the app will actually print at start-up, read out of the packaged binary
# rather than the control file, so a stale payload in a renamed archive fails
# here instead of at a reviewer's desk.
packaged_banner=$(strings -n 3 "$libdir/rook" 2>/dev/null \
  | grep -aE '^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$' | head -1)
[ -n "$packaged_banner" ] || fail "no version string in the packaged host binary"
[ "${packaged_banner%%-*}" = "$deb_version" ] ||
  fail "the packaged app reports $packaged_banner, the archive says $deb_version"
ok "in-app" "banner reports rook $packaged_banner (release $deb_version)"

# --- display -----------------------------------------------------------------
# :99 is shared with whatever else runs QA on this box, and `import -window`
# grabs the screen rectangle of our window: if another app (a headful Chrome E2E,
# say) overlaps it, the PNG shows *their* pixels. So the default is a private
# Xvfb; ROOK_DISPLAY=:99 opts back into the shared one.
say "display"
xvfb_bin="${XVFB_BIN:-$(command -v Xvfb || true)}"
display="${ROOK_DISPLAY:-}"
start_xvfb() {
  LD_LIBRARY_PATH="${XVFB_LIB:+$XVFB_LIB:}${LD_LIBRARY_PATH:-}" \
    "$xvfb_bin" "$1" -screen 0 1440x900x24 -nolisten tcp -ac >"$work/xvfb.log" 2>&1 &
  xvfb_pid=$!
  for _ in $(seq 1 40); do
    xdpyinfo -display "$1" >/dev/null 2>&1 && return 0
    sleep 0.25
  done
  return 1
}
if [ -n "$display" ]; then
  xdpyinfo -display "$display" >/dev/null 2>&1 || fail "ROOK_DISPLAY=$display has no server"
  windows=$(DISPLAY="$display" xwininfo -root -tree 2>/dev/null | grep -c '^     0x' || true)
  step "display" "$display (ROOK_DISPLAY; $windows windows mapped)"
  [ "${windows:-0}" -le 2 ] || warn "other windows are mapped on $display; a capture may include them"
else
  [ -n "$xvfb_bin" ] || fail "no private display possible: Xvfb not found (set ROOK_DISPLAY to use an existing one)"
  for n in $(seq 95 120); do
    [ -e "/tmp/.X11-unix/X$n" ] && continue
    if start_xvfb ":$n"; then display=":$n"; break; fi
    [ -n "$xvfb_pid" ] && kill "$xvfb_pid" 2>/dev/null
    xvfb_pid=""
  done
  [ -n "$display" ] || fail "could not start a private Xvfb on :95-:120"
  step "display" "$display (private Xvfb, pid $xvfb_pid)"
fi

# --- fixtures ----------------------------------------------------------------
port=$(python3 - <<'PY'
import socket
s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()
PY
) || fail "could not pick a free port"
python3 -m http.server "$port" --bind 127.0.0.1 --directory "$repo_dir/host/fixtures" \
  >"$work/fixtures.log" 2>&1 &
server_pid=$!
base="http://127.0.0.1:$port"
served=0
for _ in $(seq 1 60); do
  if python3 - "$base/isolation.html" <<'PY'
import sys, urllib.request
try:
    urllib.request.urlopen(sys.argv[1], timeout=1).read(1)
except Exception:
    sys.exit(1)
PY
  then served=1; break; fi
  sleep 0.1
done
[ "$served" = 1 ] || fail "fixture server did not answer on $base"
step "fixtures" "$base (python3 http.server, pid $server_pid)"

# --- 4. does the packaged payload actually load? -----------------------------
say "payload provenance"
data="$work/data"
mkdir -p "$data" "$work/runtime"
DISPLAY="$display" XDG_DATA_HOME="$data" XDG_RUNTIME_DIR="$work/runtime" \
  "$root/usr/bin/rook" --no-control-socket --url "$base/isolation.html?label=provenance" \
  >"$work/provenance.log" 2>&1 &
app_pid=$!
maps=""
for _ in $(seq 1 60); do
  sleep 0.25
  [ -r "/proc/$app_pid/maps" ] || continue
  maps=$(grep -o '[^ ]*libcef\.so' "/proc/$app_pid/maps" 2>/dev/null | sort -u | head -1)
  [ -n "$maps" ] && break
done
kill "$app_pid" 2>/dev/null; wait "$app_pid" 2>/dev/null; app_pid=""
[ -n "$maps" ] || fail "the app never mapped libcef.so (log: $work/provenance.log)"
step "libcef.so from" "$maps"
case "$maps" in
  "$root"/*) ok "provenance" "the packaged libcef.so, not host/cef-runtime" ;;
  *) fail "loaded $maps — that is not the packaged payload" ;;
esac
runtime_dir=$(grep -o 'ROOK_CEF_RUNTIME=[^ ]*' "$work/provenance.log" 2>/dev/null || true)
[ -z "$runtime_dir" ] || step "runtime env" "$runtime_dir"

# --- 5. render ---------------------------------------------------------------
say "render (unpacked launcher, --screenshot)"
png="$work/screenshot.png"
rm -f "$png"
t0=$(date +%s)
DISPLAY="$display" XDG_DATA_HOME="$data" XDG_RUNTIME_DIR="$work/runtime" \
  timeout 120 "$root/usr/bin/rook" \
    --screenshot "$png" \
    --space "You=$base/notes.html,$base/isolation.html?label=You" \
    --space "Agent 1=$base/isolation.html?label=Agent1" \
    --verify-isolation >>"$work/render.log" 2>&1
rc=$?
[ "$rc" -eq 0 ] || fail "launcher exited $rc (log: $work/render.log)"
[ -s "$png" ] || fail "no screenshot written"
t1=$(date +%s)
grep -q 'screenshot FAILED' "$work/render.log" && fail "the app reported a screenshot failure"

read -r width height colours mean sd < <(identify -format '%w %h %k %[fx:mean] %[fx:standard_deviation]\n' "$png" | head -1)
step "screenshot" "$png"
step "geometry" "${width}x${height} in $((t1 - t0))s, $(( $(stat -c %s "$png") / 1024 )) KB"
step "pixels" "${colours} colours, mean ${mean}, sd ${sd}"
[ "$width" -ge 1000 ] || fail "screenshot is only ${width}px wide"
[ "$height" -ge 700 ] || fail "screenshot is only ${height}px tall"
[ "$colours" -ge 500 ] || fail "frame looks blank: $colours colours"
awk -v sd="$sd" 'BEGIN { exit (sd > 0.02) ? 0 : 1 }' || fail "frame looks flat: sd $sd"
loaded=$(grep -c 'loaded (http 200)' "$work/render.log" || true)
[ "$loaded" -ge 1 ] || fail "no page reported a successful load (log: $work/render.log)"
sbx=$(grep -cE '^\[rook\] (sandbox: enabled|WARNING: Chromium sandbox disabled)' "$work/render.log" || true)
[ "$sbx" -ge 1 ] || fail "no sandbox decision line in the run log (log: $work/render.log)"
step "sandbox" "$(grep -m1 -oE '\[rook\] (sandbox: enabled \([^)]*\)|WARNING: Chromium sandbox disabled)' "$work/render.log" || true)"
ok "render" "window painted from the packaged binaries, $loaded page(s) loaded over HTTP"

you_line=$(grep -m1 '^\[isolation\] space="You" ' "$work/render.log" || true)
agent_line=$(grep -m1 '^\[isolation\] space="Agent 1" ' "$work/render.log" || true)
[ -n "$you_line" ] && [ -n "$agent_line" ] || fail "no per-space storage report (log: $work/render.log)"
step "You" "${you_line#*] }"
step "Agent 1" "${agent_line#*] }"
field() { printf '%s' "$1" | sed -n "s/.*$2=\"\([^\"]*\)\".*/\1/p"; }
[ -n "$(field "$you_line" localStorage)" ] || fail "space You reported no localStorage value (storage blocked?)"
[ -n "$(field "$agent_line" localStorage)" ] || fail "space Agent 1 reported no localStorage value (storage blocked?)"

# The model this release ships: a profile is the isolation boundary, one
# CefRequestContext per profile, shared by every space in it. Two spaces of one
# profile therefore see the same store. Proving that from one run is a race: both
# tabs load at the same instant and the fixture writes a label only when the
# store is empty, so concurrent first loads can each write their own. Each run
# below is sequential instead, which is how a user and an agent actually meet
# this: run A writes a label into the default profile, run B (same profile, same
# XDG_DATA_HOME) must read A's label back, and run C (another profile) must not.
say "profile storage (sequential runs, one data dir)"
iso="$work/profile-check"
rm -rf "$iso"; mkdir -p "$iso/data" "$iso/run"
iso_run() { # $1 = tag, $2 = label, $3 = profile id; prints the isolation line
  local tag="$1" label="$2" profile="$3" line
  DISPLAY="$display" XDG_DATA_HOME="$iso/data" XDG_RUNTIME_DIR="$iso/run" \
    timeout 120 "$root/usr/bin/rook" \
      --screenshot "$iso/$tag.png" \
      --profile "$profile" \
      --space "S=$base/isolation.html?label=$label" \
      --verify-isolation >"$iso/$tag.log" 2>&1 ||
    { echo "run $tag (profile $profile) exited non-zero" >&2; return 1; }
  [ -s "$iso/$tag.png" ] || { echo "run $tag wrote no screenshot" >&2; return 1; }
  line=$(grep -m1 '^\[isolation\] space="S" ' "$iso/$tag.log" || true)
  [ -n "$line" ] || { echo "run $tag printed no isolation line" >&2; return 1; }
  # stderr, so the caller's $(...) gets the isolation line and nothing else.
  printf '  %-20s %s\n' "$tag" "profile $profile, label=$label -> ${line#*] }" >&2
  printf '%s' "$line"
}
first=$(iso_run a Alpha default) || fail "profile storage run a failed (log: $iso/a.log)"
first_store=$(field "$first" localStorage)
second=$(iso_run b Beta default) || fail "profile storage run b failed (log: $iso/b.log)"
second_store=$(field "$second" localStorage)
third=$(iso_run c Gamma pkg-second) || fail "profile storage run c failed (log: $iso/c.log)"
third_store=$(field "$third" localStorage)
[ "$first_store" = "Alpha" ] || fail "run a wrote \"$first_store\", expected the label Alpha"
[ "$second_store" = "$first_store" ] ||
  fail "profile default read \"$second_store\" on the second run; it shared no storage with the first (\"$first_store\")"
ok "shared" "profile default kept \"$second_store\" across two runs (spaces share the profile's context)"
[ "$third_store" != "$first_store" ] ||
  fail "profile pkg-second read \"$third_store\", which is profile default's storage: the contexts are not separate"
ok "separate" "profile pkg-second read \"$third_store\"; profile default read \"$first_store\""


# --- 6. the CLI, when the package carries an SDK bundle ----------------------
say "cli (bundled SDK)"
if [ -f "$libdir/sdk/index.js" ]; then
  backend=$("$root/usr/bin/ego-browser" backend 2>&1) || fail "ego-browser backend failed: $backend"
  step "backend" "$(printf '%s' "$backend" | head -1)"

  e2e="$work/e2e"; rm -rf "$e2e"; mkdir -p "$e2e/run" "$e2e/data"
  DISPLAY="$display" XDG_DATA_HOME="$e2e/data" XDG_RUNTIME_DIR="$e2e/run" \
    "$root/usr/bin/rook" --window-size 1000x700 >"$e2e/app.log" 2>&1 &
  app_pid=$!
  sock="$e2e/run/rook-$(id -u).sock"
  for _ in $(seq 1 80); do [ -S "$sock" ] && break; sleep 0.25; done
  [ -S "$sock" ] || fail "the unpacked app never opened $sock (log: $e2e/app.log)"
  step "socket" "$sock"
  round=$(ROOK_BACKEND=host XDG_RUNTIME_DIR="$e2e/run" timeout 90 \
    "$root/usr/bin/ego-browser" nodejs -e '
const task = await taskSpace("pkgcheck")
const page = task.page("p1")
await page.goto("'"$base"'/notes.html")
const snap = String(await page.snapshot())
console.log("SNAPSHOT:", snap.split("\n").filter(Boolean)[0])
await task.finish({ keep: [] })
' 2>&1); rc=$?
  kill "$app_pid" 2>/dev/null; wait "$app_pid" 2>/dev/null; app_pid=""
  [ "$rc" -eq 0 ] || fail "an agent round through the packaged CLI exited $rc: $round"
  printf '%s\n' "$round" | grep -q 'SNAPSHOT:' || fail "the round printed no snapshot: $round"
  step "round" "$(printf '%s\n' "$round" | grep -m1 'SNAPSHOT:' | cut -c1-96)"
  ok "cli" "bundled node + bridge + SDK drove the packaged app"
else
  step "skipped" "no sdk/index.js in the package (vendor/ego-browser absent at build time)"
fi

# --- 7. dependencies ---------------------------------------------------------
say "dependency coverage"
depends=$(dpkg-deb -f "$deb" Depends | tr -d '\n' | tr '|,' '\n\n' \
  | sed -e 's/([^)]*)//g' -e 's/^ *//' -e 's/ *$//' | grep -v '^$')
libcef="$libdir/cef/libcef.so"
host="$libdir/rook"

# Every soname either binary asks the loader for, resolved on this box and
# mapped back to the package that owns it.
needed=$( { readelf -d "$host"; readelf -d "$libcef"; } | sed -n 's/.*(NEEDED).*\[\(.*\)\]/\1/p' | sort -u )
missing=0
covered=0
while read -r soname; do
  [ -n "$soname" ] || continue
  case "$soname" in
    libcef.so|ld-linux-x86-64.so.2) continue ;;
  esac
  path=$(LD_LIBRARY_PATH="$libdir/cef" ldd "$host" 2>/dev/null | awk -v s="$soname" '$1==s{print $3; exit}')
  [ -n "$path" ] || path=$(ldconfig -p | awk -v s="$soname" '$1==s{print $NF; exit}')
  pkg=$(dpkg -S "$(readlink -f "$path")" 2>/dev/null | cut -d: -f1 | head -1)
  essential=""
  [ -n "$pkg" ] && essential=$(dpkg-query -W -f='${Essential}' "$pkg" 2>/dev/null || true)
  if [ -z "$pkg" ]; then
    printf '  %-24s %-44s %s\n' "$soname" "${path:-not found}" "UNMAPPED"
    missing=$((missing + 1))
  elif [ "$essential" = "yes" ]; then
    # Debian policy: Essential packages are not listed in Depends (libc6).
    covered=$((covered + 1))
  elif printf '%s\n' "$depends" | grep -Fxq "$pkg"; then
    covered=$((covered + 1))
  else
    printf '  %-24s %-44s %s\n' "$soname" "$path" "NOT IN Depends ($pkg)"
    missing=$((missing + 1))
  fi
done <<< "$needed"
ok "sonames" "$covered covered by Depends, $missing uncovered"
[ "$missing" -eq 0 ] || fail "$missing soname(s) not covered by the control file"

# Nothing may reference the build tree: a clean machine has no such paths.
# The app may name its own profile dir (under packaging/work); what must not
# appear is the development tree it was built from.
if grep -qE "$repo_dir/(host|runtime|bin)" "$work/render.log" 2>/dev/null; then
  grep -m3 -E "$repo_dir/(host|runtime|bin)" "$work/render.log" | sed 's/^/  build-tree path: /'
  fail "the app referenced paths in the build tree"
fi
ok "clean tree" "no build-tree path in the app's log"

# --- 8. licences -------------------------------------------------------------
say "licences"
# MIT and BSD-3 both require the copyright notice and the permission text to
# accompany the distributed binary, so a package that carries the binaries but
# not their texts is not distributable. Checked in the archive, not in the
# staging tree: this is what an installer actually receives.
licence_missing=0
for doc in LICENSE NOTICE copyright sdk-LICENSE cef-LICENSE.txt cef-CREDITS.html.gz node-LICENSE; do
  line=$(printf '%s\n' "$files" | grep -E "usr/share/doc/rook/$doc\$" || true)
  if [ -z "$line" ]; then
    printf '  %-22s %s\n' "$doc" "MISSING"
    licence_missing=$((licence_missing + 1))
  else
    printf '  %-22s %8s bytes\n' "$doc" "$(printf '%s' "$line" | awk '{print $3}')"
  fi
done
[ "$licence_missing" -eq 0 ] || fail "$licence_missing of the 7 documentation files are not in the archive"

docdir="$root/usr/share/doc/rook"
grep -qi 'MIT License' "$docdir/sdk-LICENSE" \
  || fail "sdk-LICENSE does not contain the MIT text"
grep -q 'Redistribution and use in source and binary forms' "$docdir/cef-LICENSE.txt" \
  || fail "cef-LICENSE.txt does not contain the BSD-3 text"
# Decompress first: `zcat ... | grep -q` dies of SIGPIPE the moment grep finds a
# match, and this script runs with pipefail, which would turn a good file into a
# failure.
credits="$work/cef-CREDITS.html"
zcat "$docdir/cef-CREDITS.html.gz" > "$credits" 2>/dev/null \
  || fail "cef-CREDITS.html.gz does not decompress"
grep -qi 'chromium' "$credits" \
  || fail "cef-CREDITS.html.gz does not decompress to the engine's credit list"
grep -q 'Node.js is licensed' "$docdir/node-LICENSE" \
  || fail "node-LICENSE does not contain Node's licence"
grep -qi 'not affiliated' "$docdir/NOTICE" \
  || fail "NOTICE carries no independence statement"
ok "licences" "4 third-party texts + LICENSE/NOTICE/copyright, contents checked"
step "credits" "$(stat -c %s "$credits") bytes decompressed, $(grep -c 'class="product"' "$credits" || true) credit entries"

printf '\n\033[1m[verify] OK\033[0m  %s\n' "$deb"
printf '        screenshot %s\n' "$png"
