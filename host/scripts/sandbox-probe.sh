#!/usr/bin/env bash
# Proves the Chromium sandbox decision on this machine, both paths, without
# root, without installing anything.
#
#   scripts/sandbox-probe.sh --bin host/build/bin/rook [--display :131]
#   scripts/sandbox-probe.sh --no-live          # decision table only, no display
#
# Cases:
#   1 natural      what this host decides, with the reason and the fix
#   2 override=1   ROOK_NO_SANDBOX=1 falls back and says so
#   3 fake helper  a 4755 helper owned by the current uid is refused (a fake
#                  helper must never be enough to claim the sandbox is on)
#   4 real helper  a 4755 root:root helper flips the decision to "enabled"
#   5 forced on    ROOK_NO_SANDBOX=0 refuses to start (exit 4) where the
#                  sandbox cannot run: proved as a root-mapped user namespace
#   6 no userns    a container that blocks user namespaces (seccomp: unshare(2)
#                  -> EPERM) gets the full fallback warning with its reason
#   7 forced on    ...and ROOK_NO_SANDBOX=0 refuses there too, exit 4
#   8 live run     the decision matches what the renderers actually got
#                  (seccomp-bpf + namespaces, read from /proc, not claimed)
#   9 fallback run a whole run with ROOK_NO_SANDBOX=1: warning, screenshot,
#                  exit 0 -- the container workflow keeps working
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"

bin="${ROOK_BIN:-$root/build/bin/rook}"
display="${ROOK_DISPLAY:-:131}"
live=1

while [ $# -gt 0 ]; do
  case "$1" in
    --bin) bin="$2"; shift 2 ;;
    --display) display="$2"; shift 2 ;;
    --no-live) live=0; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) printf 'sandbox-probe: unknown argument %s\n' "$1" >&2; exit 2 ;;
  esac
done

[ -x "$bin" ] || {
  printf 'sandbox-probe: no binary at %s (build it first: ninja -C %s/build)\n' \
    "$bin" "$root" >&2
  exit 2
}

work="$root/artifacts/sandbox-probe"
mkdir -p "$work"

failures=0
pass() { printf '  \033[32mPASS\033[0m %-16s %s\n' "$1" "$2"; }
bad() { printf '  \033[31mFAIL\033[0m %-16s %s\n' "$1" "$2"; failures=$((failures + 1)); }
skip() { printf '  \033[33mSKIP\033[0m %-16s %s\n' "$1" "$2"; }
say() { printf '\n\033[1m[probe]\033[0m %s\n' "$*"; }
show() { printf '%s\n' "$@" | sed 's/^/       /'; }

# field <key> <probe output>: the value after "[rook] sandbox: <key>".
field() {
  printf '%s\n' "$2" | awk -v key="$1" '
    $1 == "[rook]" && $2 == "sandbox:" && $3 == key {
      sub(/^\[rook\] sandbox: [a-z]+ +/, ""); print; exit
    }'
}

app=""
server=""
cleanup() {
  [ -n "$app" ] && kill "$app" 2>/dev/null
  [ -n "$server" ] && kill "$server" 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
say "1. natural decision (no overrides)"
# env -u: the decision must not inherit an override from the caller.
natural_out="$(env -u ROOK_NO_SANDBOX -u CHROME_DEVEL_SANDBOX \
  ROOK_SANDBOX_PROBE=1 "$bin" 2>&1)"
natural_rc=$?
show "$natural_out"
natural_decision="$(field decision "$natural_out")"
natural_reason="$(field reason "$natural_out")"
if [ "$natural_rc" -ne 0 ]; then
  bad natural "ROOK_SANDBOX_PROBE=1 exited $natural_rc"
elif [ -z "$natural_decision" ]; then
  bad natural "no 'sandbox: decision' line in the probe output"
else
  pass natural "$natural_decision"
  pass reason "$natural_reason"
fi

# ---------------------------------------------------------------------------
say "2. ROOK_NO_SANDBOX=1 (the container / forced fallback path)"
off_out="$(env ROOK_NO_SANDBOX=1 ROOK_SANDBOX_PROBE=1 "$bin" 2>&1)"
off_rc=$?
show "$off_out"
if [ "$off_rc" -ne 0 ]; then
  bad override "probe exited $off_rc"
elif [ "$(field decision "$off_out")" != "disabled (ROOK_NO_SANDBOX=1)" ]; then
  bad override "decision is '$(field decision "$off_out")', expected disabled"
elif ! grep -q 'message   \[rook\] WARNING: Chromium sandbox disabled by ROOK_NO_SANDBOX=1' <<<"$off_out"; then
  bad override "the fallback is silent: no warning in the probe output"
else
  pass override "disabled, and it warns instead of weakening silently"
fi

# ---------------------------------------------------------------------------
say "3. a 4755 helper owned by this user (a fake helper must not count)"
fake_dir="$(mktemp -d "${TMPDIR:-/tmp}/rook-sandbox-fake-XXXXXX")"
printf '#!/bin/sh\nexit 1\n' >"$fake_dir/chrome-sandbox"
chmod 4755 "$fake_dir/chrome-sandbox"
fake_out="$(env CHROME_DEVEL_SANDBOX="$fake_dir/chrome-sandbox" \
  ROOK_SANDBOX_PROBE=1 "$bin" 2>&1)"
show "$fake_out"
if grep -q '^\[rook\] sandbox: helper    accepted' <<<"$fake_out"; then
  bad fake-helper "a helper owned by uid $(id -u) was accepted"
elif ! grep -q "helper    rejected:.*owned by uid $(id -u)" <<<"$fake_out"; then
  bad fake-helper "no 'owned by uid $(id -u)' rejection in the output"
elif [ "$(field decision "$fake_out")" = "enabled via setuid helper" ]; then
  bad fake-helper "decision still says setuid helper"
else
  pass fake-helper "rejected: $(field helper "$fake_out")"
fi
rm -rf "$fake_dir"

# ---------------------------------------------------------------------------
say "4. a real 4755 root:root helper flips the decision to enabled"
# An unprivileged user cannot create a root-owned file, so borrow one that
# already exists: only the mode and the owner matter to the decision (Chromium
# verifies the file itself and aborts loudly if it is the wrong binary, so this
# is a decision-layer fixture, not a claim that /usr/bin/mount is a sandbox).
real_helper=""
for candidate in /usr/bin/mount /usr/bin/passwd /usr/bin/su /usr/bin/chsh \
                 /usr/bin/sudo /usr/bin/umount /usr/bin/fusermount3; do
  if [ -f "$candidate" ] && [ -u "$candidate" ] &&
     [ "$(stat -c %u "$candidate" 2>/dev/null)" = "0" ]; then
    real_helper="$candidate"
    break
  fi
done
if [ -z "$real_helper" ]; then
  skip real-helper "no 4755 root:root file on this system to point at"
else
  helper_out="$(env CHROME_DEVEL_SANDBOX="$real_helper" \
    ROOK_SANDBOX_PROBE=1 "$bin" 2>&1)"
  show "$helper_out"
  if [ "$(field decision "$helper_out")" = "enabled via setuid helper" ]; then
    pass real-helper "enabled via setuid helper ($real_helper)"
  else
    bad real-helper "decision is '$(field decision "$helper_out")', expected enabled via setuid helper"
  fi
fi

# ---------------------------------------------------------------------------
say "5. ROOK_NO_SANDBOX=0 where the sandbox cannot run: refuse, don't start"
# A root-mapped user namespace is an honest unusable case on this box: Chromium
# does not start sandboxed as uid 0, so a normal run must not fall back.
if ! unshare -Ur true >/dev/null 2>&1; then
  skip forced-on "unshare -Ur is not permitted here"
else
  forced_out="$("unshare" -Ur env ROOK_NO_SANDBOX=0 "$bin" 2>&1)"
  forced_rc=$?
  show "$forced_out"
  printf '       exit %s\n' "$forced_rc"
  if [ "$forced_rc" -ne 4 ]; then
    bad forced-on "exit $forced_rc, expected 4"
  elif ! grep -q '^\[rook\] ERROR: ROOK_NO_SANDBOX=0 asks for the Chromium sandbox' <<<"$forced_out"; then
    bad forced-on "no '[rook] ERROR:' line"
  elif ! grep -q 'Refusing to run unsandboxed' <<<"$forced_out"; then
    bad forced-on "did not refuse: no 'Refusing to run unsandboxed'"
  elif ! grep -q 'running as root' <<<"$forced_out"; then
    bad forced-on "reason does not name the cause"
  else
    pass forced-on "exit 4, refuses, names the reason"
  fi
fi

# ---------------------------------------------------------------------------
say "6. a container that blocks user namespaces (unshare(2) -> EPERM)"
# This box allows namespaces, so the fallback reason a real container produces
# can only be exercised by denying unshare(2) for real: scripts/deny-unshare.c
# installs a seccomp filter and execs the host, exactly like a container profile.
cc_bin="${CC:-}"
if [ -z "$cc_bin" ]; then
  for candidate in cc gcc; do
    if command -v "$candidate" >/dev/null 2>&1; then
      cc_bin="$candidate"
      break
    fi
  done
fi
deny=""
if [ -n "$cc_bin" ] && "$cc_bin" -O2 -o "$work/deny-unshare" "$here/deny-unshare.c" 2>"$work/deny-unshare.build.log"; then
  deny="$work/deny-unshare"
  pass deny-unshare "compiled ($cc_bin): unshare(2) and setns(2) return EPERM"
else
  skip deny-unshare "no C compiler for scripts/deny-unshare.c"
fi

if [ -n "$deny" ]; then
  container_out="$(env -u ROOK_NO_SANDBOX -u CHROME_DEVEL_SANDBOX \
    ROOK_SANDBOX_PROBE=1 "$deny" "$bin" 2>&1)"
  show "$container_out"
  container_message="$(field message "$container_out")"
  if [ "$(field decision "$container_out")" != "disabled (fallback)" ]; then
    bad no-userns "decision is '$(field decision "$container_out")', expected disabled (fallback)"
  elif ! grep -q 'userns    unshare(CLONE_NEWUSER): .*EPERM' <<<"$container_out"; then
    bad no-userns "the probe did not report the EPERM"
  elif ! grep -q 'WARNING: Chromium sandbox disabled:' <<<"$container_message"; then
    bad no-userns "no fallback warning"
  elif ! grep -q 'Fix: install the rook .deb' <<<"$container_message"; then
    bad no-userns "the warning does not say how to fix it"
  else
    pass no-userns "fallback, reason and fix in one warning line"
  fi

  # ...and with the sandbox required, it must not start.
  say "7. ROOK_NO_SANDBOX=0 in that container: refuse, don't start"
  container_forced="$(env ROOK_NO_SANDBOX=0 "$deny" "$bin" 2>&1)"
  container_rc=$?
  printf '       exit %s\n' "$container_rc"
  if [ "$container_rc" -ne 4 ]; then
    bad no-userns-forced "exit $container_rc, expected 4"
  elif ! grep -q 'Refusing to run unsandboxed' <<<"$container_forced"; then
    bad no-userns-forced "no 'Refusing to run unsandboxed'"
  elif ! grep -q 'unshare(CLONE_NEWUSER)' <<<"$container_forced"; then
    bad no-userns-forced "the reason does not name the failing call"
  else
    pass no-userns-forced "exit 4 on a box with no user namespaces"
  fi
fi

# ---------------------------------------------------------------------------
say "8. live run: does the decision match what the renderers actually got?"
if [ "$live" -eq 0 ]; then
  skip live-run "--no-live"
elif ! xdpyinfo -display "$display" >/dev/null 2>&1; then
  skip live-run "no X display on $display"
else
  port="$(python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
)"
  python3 -m http.server "$port" --bind 127.0.0.1 --directory "$root/fixtures" \
    >"$work/http.log" 2>&1 &
  server=$!
  base="http://127.0.0.1:$port"
  for _ in $(seq 1 80); do
    python3 - "$base/notes.html" <<'PY' && break
import sys, urllib.request
try:
    urllib.request.urlopen(sys.argv[1], timeout=1).read(1)
except Exception:
    sys.exit(1)
PY
    sleep 0.1
  done

  rm -rf "$work/data"
  DISPLAY="$display" XDG_DATA_HOME="$work/data" \
    env -u ROOK_NO_SANDBOX -u CHROME_DEVEL_SANDBOX \
    "$bin" --space "You=$base/notes.html" --socket-path "$work/sock" \
    >"$work/host.log" 2>&1 &
  app=$!
  for _ in $(seq 1 150); do
    grep -q 'tab tb1 loaded' "$work/host.log" && break
    kill -0 "$app" 2>/dev/null || break
    sleep 0.2
  done

  state="$(python3 "$here/proc-sandbox-state.py" "$app" 2>&1)"
  show "$state"
  case "$natural_decision" in
    enabled*)
      sandboxed=$(printf '%s\n' "$state" |
        awk '$2 == "seccomp=2" && ($4 == "pidns=diff" || $6 == "userns=diff")' |
        wc -l | tr -d ' ')
      if [ "${sandboxed:-0}" -gt 0 ]; then
        pass live-run "$sandboxed child process(es) in a seccomp + namespace sandbox"
      else
        bad live-run "decision says enabled, but no child has seccomp-bpf + a private namespace"
      fi
      grep -q '^\[rook\] sandbox: enabled' "$work/host.log" ||
        bad live-log "the run did not say the sandbox is enabled"
      ;;
    *)
      leaked=$(printf '%s\n' "$state" |
        awk '$2 == "seccomp=2" || $6 == "userns=diff"' | wc -l | tr -d ' ')
      if [ "${leaked:-0}" -eq 0 ]; then
        pass live-run "fallback: no child is sandboxed, as the decision said"
      else
        bad live-run "$leaked child process(es) look sandboxed in a fallback run"
      fi
      grep -q '^\[rook\] WARNING: Chromium sandbox disabled' "$work/host.log" ||
        bad live-log "the fallback run printed no warning"
      ;;
  esac
  kill "$app" 2>/dev/null
  app=""

  # -------------------------------------------------------------------------
  say "9. whole run with the fallback: warning, screenshot, exit 0"
  rm -rf "$work/fallback-data"
  DISPLAY="$display" XDG_DATA_HOME="$work/fallback-data" ROOK_NO_SANDBOX=1 \
    timeout 120 "$bin" --screenshot "$work/fallback.png" \
    --socket-path "$work/fallback.sock" \
    --space "You=$base/notes.html" >>"$work/fallback.log" 2>&1
  fallback_rc=$?
  if [ "$fallback_rc" -ne 0 ]; then
    bad fallback-run "exit $fallback_rc (log: $work/fallback.log)"
  elif ! grep -q '^\[rook\] WARNING: Chromium sandbox disabled by ROOK_NO_SANDBOX=1' "$work/fallback.log"; then
    bad fallback-run "no warning in the run log"
  elif grep -q '^\[rook\] sandbox: enabled' "$work/fallback.log"; then
    bad fallback-run "the run says the sandbox is enabled after ROOK_NO_SANDBOX=1"
  elif [ ! -s "$work/fallback.png" ]; then
    bad fallback-run "no screenshot at $work/fallback.png"
  else
    pass fallback-run "warned, rendered, exit 0 ($(stat -c %s "$work/fallback.png") B)"
  fi
  kill "$server" 2>/dev/null
  server=""
fi

printf '\n\033[1m[probe]\033[0m %s\n' \
  "$([ "$failures" -eq 0 ] && echo 'OK — every case behaved as documented' || echo "$failures case(s) FAILED")"
printf '        logs: %s\n' "$work"
[ "$failures" -eq 0 ]
