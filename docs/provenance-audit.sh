#!/usr/bin/env bash
# Provenance audit: is any of this tree taken from the closed-source app?
#
#   docs/provenance-audit.sh [/path/to/extracted/app] [--cef=/path/to/cef_binary_156]
#
# Rook speaks the protocol of a closed-source macOS browser. This script tests
# the claim that no code, strings, assets or UI copy were taken from that app's
# build. It works on text, not intent: it harvests distinctive identifiers out
# of the app's binaries and resources, then greps this tree for them, and it
# harvests identifiers of ours and greps the app for those.
#
#   A. app -> tree   no app-specific identifier may occur in this tree
#   B. tree -> app   an identifier unique to us may not occur in the app
#
# Three sets are set aside, because a string in them cannot tell copying from
# shared origin. Each is counted and reported, never silently dropped:
#
#   upstream SDK   vendor/ + patches/: the MIT ego-browser SDK, public, which
#                  the app also bundles (its ego-skills/ and its ego-browser
#                  helper are that same upstream project at another version).
#   engine         Chromium's own prose, from the CEF distribution's headers and
#                  from the .pak resource archives both apps embed.
#   reviewed       docs/provenance-reviewed.txt: overlaps examined by hand and
#                  recorded with the reason. Anything not in that file fails.
#
# Requires: strings (binutils), grep, awk. Optional: python3 + ImageMagick for
# the icon comparison. The app is NOT part of this repository.
#
# Exit status: 0 when direction A is empty and direction B has no unreviewed
# overlap, 1 when either turns something up, 2 on a setup problem.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# No default: the app is not part of this repository, so the caller has to say
# where their extracted copy is.
app="${APP_ROOT:-}"
cef="${CEF_ROOT:-}"
for arg in "$@"; do
  case "$arg" in
    --cef=*)  cef="${arg#--cef=}" ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)        app="$arg" ;;
  esac
done
work="${ROOK_AUDIT_DIR:-${TMPDIR:-/tmp}/rook-provenance-audit}"
reviewed_file="$repo/docs/provenance-reviewed.txt"

say()  { printf '\n\033[1m[audit]\033[0m %s\n' "$*"; }
step() { printf '  %-20s %s\n' "$1" "$2"; }
die()  { printf '\n\033[1m[audit] FAIL\033[0m %s\n' "$*" >&2; exit 2; }

for tool in strings grep awk sort; do
  command -v "$tool" >/dev/null 2>&1 || die "missing tool: $tool"
done
[ -n "$app" ] || die "no app given: pass the folder holding the extracted .app as the first argument, or set APP_ROOT"
[ -d "$app" ] || die "app not found: $app"

# Accept the .app bundle or any directory above it: that is how one unpacks it.
bundle="$app"
if [ ! -d "$bundle/Contents" ]; then
  found=$(find "$app" -maxdepth 3 -type d -name Contents -print -quit 2>/dev/null || true)
  [ -n "$found" ] || die "no Contents/ under $app; pass the folder that holds the .app"
  bundle=$(dirname "$found")
fi

mkdir -p "$work"

say "app"
step "bundle" "$bundle"

# --- corpora -----------------------------------------------------------------

corpus="$work/app-corpus.txt"
if [ ! -s "$corpus" ] || [ "$corpus" -ot "$bundle/Contents/Info.plist" ]; then
  t0=$(date +%s)
  : > "$corpus.raw"
  find "$bundle/Contents" -type f -size -64M -print0 \
    | xargs -0 -P4 -n8 sh -c 'for f; do strings -a -n 6 "$f" 2>/dev/null; done' _ >> "$corpus.raw"
  find "$bundle/Contents" -type f -size +64M -print0 \
    | while IFS= read -r -d '' f; do strings -a -n 6 "$f"; done >> "$corpus.raw"
  find "$bundle/Contents" -type f \
    \( -name '*.css' -o -name '*.html' -o -name '*.sdef' -o -name '*.plist' \
       -o -name '*.strings' -o -name '*.svg' -o -name '*.md' -o -name '*.txt' \) \
    -exec cat {} + >> "$corpus.raw" 2>/dev/null || true
  LC_ALL=C sort -u "$corpus.raw" > "$corpus"
  rm -f "$corpus.raw"
  step "corpus" "$(wc -l < "$corpus") distinct lines, $(find "$bundle/Contents" -type f | wc -l | tr -d ' ') files, $(( $(date +%s) - t0 ))s"
else
  step "corpus" "cached, $(wc -l < "$corpus") lines"
fi

# The public MIT SDK both projects build on: what we vendor, and the checkout it
# was vendored from (vendor/UPSTREAM records where that is). The full checkout
# matters: the protocol's own documentation lives there, and a string from the
# published spec is the app's to use as much as ours.
upstream_root="${EGO_UPSTREAM_ROOT:-}"
if [ -z "$upstream_root" ] && [ -f "$repo/vendor/UPSTREAM" ]; then
  upstream_root=$(sed -n 's/^source: //p' "$repo/vendor/UPSTREAM" | head -1)
fi
upstream="$work/upstream.txt"
{
  find "$repo/vendor" "$repo/patches" -type f \
    \( -name '*.ts' -o -name '*.js' -o -name '*.mjs' -o -name '*.md' -o -name '*.json' \
       -o -name '*.patch' -o -name '*.yaml' -o -name '*.sh' \) -print0 2>/dev/null \
    | xargs -0 cat 2>/dev/null || true
  if [ -n "$upstream_root" ] && [ -d "$upstream_root" ]; then
    find "$upstream_root" -type f \
      \( -name '*.ts' -o -name '*.js' -o -name '*.mjs' -o -name '*.md' -o -name '*.json' \
         -o -name '*.yaml' -o -name '*.sh' \) \
      -not -path '*/node_modules/*' -not -path '*/.git/*' -print0 2>/dev/null \
      | xargs -0 cat 2>/dev/null || true
  fi
} > "$work/upstream-raw.txt"
LC_ALL=C sort -u "$work/upstream-raw.txt" > "$upstream"
if [ -n "$upstream_root" ] && [ -d "$upstream_root" ]; then
  step "upstream" "$(wc -l < "$upstream") lines, vendor/ + $upstream_root (public MIT)"
else
  step "upstream" "$(wc -l < "$upstream") lines, vendor/ only: upstream checkout absent, so spec prose is NOT filtered"
fi

# The engine both apps embed: CEF's own text, plus the Chromium string tables
# we ship in host/cef-runtime.
engine="$work/engine.txt"
{
  if [ -n "$cef" ] && [ -d "$cef" ]; then
    cat "$cef"/LICENSE.txt "$cef"/README.txt 2>/dev/null || true
    find "$cef/include" -type f -name '*.h' -exec cat {} + 2>/dev/null || true
    find "$cef" -maxdepth 2 -type f -name '*.pak' -print0 2>/dev/null \
      | xargs -0 -n1 sh -c 'strings -a -n 6 "$0" 2>/dev/null' || true
  fi
  rt="$repo/host/cef-runtime"
  for pak in "$rt/resources.pak" "$rt/chrome_100_percent.pak" "$rt/locales/en-US.pak"; do
    [ -f "$pak" ] && strings -a -n 6 "$pak" 2>/dev/null || true
  done
} | LC_ALL=C sort -u > "$engine"
step "engine" "$(wc -l < "$engine") lines from the CEF distribution + cef-runtime .pak"

# Control for the filter itself. A shared-origin filter that matches nothing
# would quietly let upstream material through as "discriminating", and one that
# matches everything would swallow the tree. Both cases are checked.
grep -qaiF -e 'EGO_TASK_SPACE_USER_IN_CONTROL' "$upstream" \
  || die "filter control: a string the upstream SDK certainly has is not in the upstream corpus"
! grep -qaiF -e 'spacerow' "$upstream" \
  || die "filter control: 'spacerow' (ours alone) occurs in the upstream corpus"
step "filter control" "known upstream string found, known-ours string absent"

# --- probe discipline --------------------------------------------------------

# A literal string is only evidence if it is distinctive. These rules drop the
# vocabulary every codebase has, and keep what a copy would have to carry:
# sentences, names with a separator, CSS classes, symbols. File names go too:
# every tree has a control.h, and `#include "control.h"` is not a name.
distinctive() {
  awk 'length($0) >= 8' "$1" \
  | grep -avE '^[a-z]+$' \
  | grep -avE '^(true|false|null|undefined|function|return|string|number|object)$' \
  | grep -avE '^[0-9]+$' \
  | grep -avE '^\$|^%|^\{|^\[' \
  | grep -avE '\.(h|hpp|cc|cpp|js|mjs|json|md|txt|sh|py|css|html|patch|ya?ml)$' \
  | LC_ALL=C sort -u
}

token_patterns() { # $1 = probes, $2 = output: one ERE per probe, whole-token match
  : > "$2"
  while IFS= read -r p; do
    esc=$(printf '%s' "$p" | sed 's/[^a-zA-Z0-9_ -]/\\&/g')
    printf '(^|[^A-Za-z0-9_])%s([^A-Za-z0-9_]|$)\n' "$esc" >> "$2"
  done < "$1"
}

# A probe that occurs anywhere in the upstream SDK or in the engine cannot
# distinguish copying from shared origin. Substring, not whole line: the point
# is whether the text exists in that material at all. Case-insensitive to match
# the hit scan below, or a probe would be detectable at one case and unfiltered
# at another (`highlightMouseTo` inside upstream's
# `animationHighlightMouseToPosition` is shared origin, not a copy).
#
# Both sides are folded to lower case once and then compared with plain grep -F:
# nine thousand probes against 40 MB of material is minutes with -i and seconds
# without, and the result is the same.
split_shared() { # $1 candidates, $2 kept, $3 shared
  : > "$2"; : > "$3"
  cat "$upstream" "$engine" | tr 'A-Z' 'a-z' > "$work/haystack.lower"
  while IFS= read -r p; do
    if grep -qaF -- "$(printf '%s' "$p" | tr 'A-Z' 'a-z')" "$work/haystack.lower" 2>/dev/null; then
      printf '%s\n' "$p" >> "$3"
    else
      printf '%s\n' "$p" >> "$2"
    fi
  done < "$1"
}

# One line per distinct probe that hit. The hits file carries file:line:text.
report_hits() { # $1 hits, $2 probes
  while IFS= read -r line; do
    local loc probe
    loc=$(printf '%s' "$line" | cut -d: -f1,2 | sed "s|^$repo/||; s|^$work/||")
    probe=$(printf '%s\n' "$line" | cut -d: -f3- | tr 'A-Z' 'a-z')
    probe=$(awk -v l="$probe" 'index(l, tolower($0)) { print; exit }' "$2")
    printf '    %-40s %s\n' "${probe:-(unnamed)}" "$loc"
  done < "$1" | sort -u
}

# --- direction A: probes from the app ---------------------------------------

say "probes, A: app -> tree"

# 1. identity: bundle ids and hostnames.
grep -aoE 'com\.citrolabs\.[A-Za-z0-9._-]+' "$corpus" | sort -u > "$work/p1"
grep -aoE '[a-z0-9.-]*citrolabs\.ai[A-Za-z0-9/._-]*' "$corpus" | sort -u > "$work/p2"

# 2. the symbols the app's own code adds to Chromium: UMA histogram names, view
#    class members, preference keys.
grep -aoE 'Ego\.[A-Za-z0-9_.]{4,}' "$corpus" | sort -u > "$work/p3"
grep -aoE 'k[A-Z][A-Za-z0-9]*(Space|Ego)[A-Za-z0-9]*' "$corpus" | sort -u > "$work/p4"
grep -aoE 'ego\.[a-z][a-z0-9_.]{6,}' "$corpus" | sort -u > "$work/p5"

# 3. UI copy: sentences long enough to be unmistakable, carrying app
#    vocabulary, minus paths, format strings and licence boilerplate.
grep -aiE '.{30,}' "$corpus" \
  | grep -aiE '\b(ego|space|spaces|agent|task)\b' \
  | grep -avE '://|\.\./|%[sd]|\{[0-9]|^[<{[]|Copyright|Permission is hereby|LICENSE|\.(h|cc|mm|js|css)$' \
  | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
  | awk 'length($0) >= 30 && length($0) <= 160' \
  | LC_ALL=C sort -u > "$work/p6"

# 4. CSS class names from the app's bundled web front-end. A class has to carry
#    a separator to be a name rather than a dictionary word.
find "$bundle/Contents" -name '*.css' -exec grep -ahoE '\.[a-zA-Z][a-zA-Z0-9]*[-_][a-zA-Z0-9_-]{3,}' {} + 2>/dev/null \
  | LC_ALL=C sort -u > "$work/p7"

# 5. the app's own source paths, baked into its debug info.
grep -aoE '(\.\./)+ego/[A-Za-z0-9_/.-]+' "$corpus" | LC_ALL=C sort -u > "$work/p8"

# 6. SVG path data from the app's asset pipeline.
find "$bundle/Contents" -name '*.svg' -exec grep -ahoE 'd="[^"]{40,}"' {} + 2>/dev/null \
  | sed 's/^d="//; s/"$//' | LC_ALL=C sort -u > "$work/p9" || true

cat "$work"/p[1-9] | grep -av '^$' | LC_ALL=C sort -u > "$work/probes.all"
distinctive "$work/probes.all" > "$work/probes.kept"
split_shared "$work/probes.kept" "$work/probes.disc" "$work/probes.shared"

count() { grep -c . "$1" 2>/dev/null || true; }
printf '  %-20s %s\n' "identity"      "$(( $(count "$work/p1") + $(count "$work/p2") )) bundle ids + hostnames"
printf '  %-20s %s\n' "symbols"       "$(( $(count "$work/p3") + $(count "$work/p4") + $(count "$work/p5") )) histograms, view members, prefs"
printf '  %-20s %s\n' "ui copy"       "$(count "$work/p6") sentences"
printf '  %-20s %s\n' "css classes"   "$(count "$work/p7") class names"
printf '  %-20s %s\n' "source paths"  "$(count "$work/p8") file names"
printf '  %-20s %s\n' "svg paths"     "$(count "$work/p9") path strings"
step "generated"     "$(count "$work/probes.all") probes"
step "set aside"     "$(count "$work/probes.shared") occur in the upstream SDK or the engine"
step "discriminating" "$(count "$work/probes.disc") used for the verdict"

# --- the tree under test -----------------------------------------------------

# Everything this repository owns. vendor/ is searched separately, on its own
# line, never as evidence about the app.
tree=(
  "$repo/host/src" "$repo/host/scripts" "$repo/host/fixtures"
  "$repo/host/CMakeLists.txt" "$repo/host/README.md"
  "$repo/runtime" "$repo/bin" "$repo/scripts" "$repo/test"
  "$repo/packaging/common.sh" "$repo/packaging/build-deb.sh" "$repo/packaging/build-appimage.sh"
  "$repo/packaging/verify-deb.sh" "$repo/packaging/README.md"
  "$repo/packaging/assets" "$repo/packaging/launcher"
  "$repo/docs" "$repo/bench" "$repo/README.md" "$repo/LICENSE" "$repo/NOTICE" "$repo/package.json"
)
# Build output, not source.
prune='--exclude-dir=work --exclude-dir=out --exclude-dir=build --exclude-dir=build-* --exclude-dir=node_modules'

say "A: app identifiers in this tree"
hits_a="$work/hits-a.txt"
# shellcheck disable=SC2086
grep -rniF $prune -f "$work/probes.disc" "${tree[@]}" > "$hits_a" 2>/dev/null || true

# Control: a string that exists only in our tree must be reported, or the grep
# is not reading the tree and a zero result would prove nothing.
control='spacerow'
control_hits=$(grep -rniF $prune -e "$control" "${tree[@]}" 2>/dev/null | wc -l | tr -d ' ')
[ "$control_hits" -gt 0 ] \
  || die "control probe '$control' not found in the tree: the grep is not reading it, so a zero result would be meaningless"
step "control" "'$control' found in $control_hits line(s) of our tree"

n_a=$(count "$hits_a")
if [ "$n_a" -eq 0 ]; then
  step "result" "0 of $(count "$work/probes.disc") probes occur anywhere in the tree"
else
  step "result" "$n_a matching line(s)"
  report_hits "$hits_a" "$work/probes.disc"
fi

# --- direction B: our identifiers in the app --------------------------------

say "probes, B: tree -> app"
{
  # CSS classes and user-visible copy from the GTK shell. The class keeps its
  # leading dot on purpose: `.spacerow` is a name, `spacerow` would be filtered
  # as an ordinary English word.
  grep -ohE '^\.[a-z][a-z0-9-]{4,}' "$repo/host/src/shell.cc"
  grep -ohE '"[A-Z][^"]{12,}"'    "$repo/host/src/shell.cc" | tr -d '"'
  # Error codes the bridge and CLI define.
  grep -rohE '\bEGO_[A-Z_]{4,}\b' "$repo/runtime" "$repo/host/src" 2>/dev/null || true
  # Types of our own C++, and the verbs and pushes of our control socket.
  grep -rohE '\b[A-Z][A-Za-z]{3,}(Shell|Space|Tab|Banner|Highlight|Sandbox|Control)[A-Za-z]{2,}\b' \
    "$repo/host/src" 2>/dev/null || true
  grep -rohE '"[a-z]([a-zA-Z]{4,})([A-Z][a-zA-Z]{3,})+"' "$repo/host/src/control_rpc.cc" 2>/dev/null \
    | tr -d '"' || true
  grep -rohE '"[a-z]+\.[a-z]+(\.[a-z]+)?"' "$repo/host/src/control_rpc.cc" "$repo/host/src/shell.cc" 2>/dev/null \
    | tr -d '"' || true
} | LC_ALL=C sort -u > "$work/ours.all"

# UI copy of ours needs three words to be copy rather than a stock phrase.
awk '{
  n = split($0, w, " ")
  if ($0 ~ /^[A-Z]/ && length($0) < 20) next
  if ($0 ~ / / && n < 3) next
  print
}' "$work/ours.all" | LC_ALL=C sort -u > "$work/ours.filt"

distinctive "$work/ours.filt" > "$work/ours.kept"
split_shared "$work/ours.kept" "$work/ours.disc" "$work/ours.shared"
n_b_probes=$(count "$work/ours.disc")
step "generated"      "$(count "$work/ours.all") identifiers"
step "not copy"       "$(( $(count "$work/ours.all") - $(count "$work/ours.filt") )) fewer than three words (a stock phrase is not copy)"
step "set aside"      "$(count "$work/ours.shared") occur in the upstream SDK or the engine"
step "discriminating" "$n_b_probes"

hits_b="$work/hits-b.txt"
# Whole tokens, not substrings: our names are short enough that substring
# matching trades a real hit for a lot of noise (`.tabstrip` inside Chromium's
# `Tabs.VerticalTabs.TabStripSize` is not a shared name). Direction A keeps
# substring matching on purpose, because a 30-character sentence is its own
# evidence even where a localisation archive runs it into its neighbours.
token_patterns "$work/ours.disc" "$work/ours.patterns"
grep -nHaiE -f "$work/ours.patterns" "$corpus" > "$hits_b" 2>/dev/null || true
n_b=$(count "$hits_b")
if [ "$n_b" -eq 0 ]; then
  step "result" "0 of $n_b_probes occur in the app's corpus as whole tokens"
else
  step "result" "$n_b matching line(s) in the app's corpus"
  while IFS= read -r line; do
    text=$(printf '%s\n' "$line" | cut -d: -f3-)
    probe=""
    while IFS= read -r p; do
      esc=$(printf '%s' "$p" | sed 's/[^a-zA-Z0-9_ -]/\\&/g')
      if printf '%s\n' "$text" | grep -qaiE "(^|[^A-Za-z0-9_])${esc}([^A-Za-z0-9_]|$)"; then
        probe="$p"; break
      fi
    done < "$work/ours.disc"
    printf '    %-38s %s\n' "${probe:-(unnamed)}" "$(printf '%s' "$line" | cut -d: -f1,2 | sed "s|^$work/||")"
  done < "$hits_b" | sort -u
fi

# --- reviewed overlaps -------------------------------------------------------

# Anything in both directions that was examined by hand lives in
# docs/provenance-reviewed.txt with the reason it is not copying. The file has
# to stay short and readable; an unexplained overlap is a failure, not a note.
say "reviewed overlaps"
declare -A reviewed=()
if [ -f "$reviewed_file" ]; then
  while IFS=$'\t' read -r id reason; do
    case "$id" in ''|'#'*) continue ;; esac
    reviewed["$id"]="$reason"
  done < "$reviewed_file"
  step "ledger" "$(count <(grep -vE '^#|^$' "$reviewed_file")) entries, docs/provenance-reviewed.txt"
else
  step "ledger" "absent"
fi

unexplained=0
explained=0
if [ "$n_a" -gt 0 ] || [ "$n_b" -gt 0 ]; then
  while IFS= read -r line; do
    loc=$(printf '%s' "$line" | cut -d: -f1,2 | sed "s|^$repo/||; s|^$work/||")
    text=$(printf '%s\n' "$line" | cut -d: -f3- | tr 'A-Z' 'a-z')
    probe=$(awk -v l="$text" 'index(l, tolower($0)) { print; exit }' "$work/probes.disc" 2>/dev/null || true)
    [ -n "$probe" ] || probe=$(awk -v l="$text" 'index(l, tolower($0)) { print; exit }' "$work/ours.disc")
    if [ -n "${reviewed[$probe]:-}" ]; then
      explained=$((explained + 1))
      printf '    %-34s %-26s %s\n' "$probe" "$loc" "reviewed: ${reviewed[$probe]}"
    else
      unexplained=$((unexplained + 1))
      printf '    %-34s %-26s %s\n' "$probe" "$loc" "UNREVIEWED"
    fi
  done < <(cat "$hits_a" "$hits_b" 2>/dev/null | sort -u)
fi
step "explained"   "$explained line(s) match a reviewed entry"
step "unexplained" "$unexplained line(s)"

# --- assets ------------------------------------------------------------------

say "assets"
icon_png="$repo/packaging/assets/rook-256.png"
app_icns="$bundle/Contents/Resources/app.icns"
if [ -f "$icon_png" ] && [ -f "$app_icns" ] && command -v python3 >/dev/null 2>&1; then
  # ICNS is a container: a type tag, a length, then bytes. ic07..ic10 are PNG.
  slice=$(python3 - "$app_icns" "$work" <<'PY'
import struct, sys
icns, work = sys.argv[1], sys.argv[2]
want = {b"ic07": 128, b"ic08": 256, b"ic09": 512, b"ic10": 1024}
data = open(icns, "rb").read()
if data[:4] != b"icns":
    raise SystemExit(0)
pos, best = 8, None
while pos + 8 <= len(data):
    tag, size = data[pos:pos+4], struct.unpack(">I", data[pos+4:pos+8])[0]
    if size < 8:
        break
    body = data[pos+8:pos+size]
    if tag in want and body[:8] == b"\x89PNG\r\n\x1a\n" and (best is None or want[tag] > best[1]):
        best = (body, want[tag])
    pos += size
if best is None:
    raise SystemExit(0)
out = f"{work}/app-icon-{best[1]}.png"
open(out, "wb").write(best[0])
print(out)
PY
)
  if [ -n "${slice:-}" ] && [ -f "$slice" ]; then
    px=$(identify -format '%wx%h' "$slice" 2>/dev/null || echo '?x?')
    if command -v compare >/dev/null 2>&1; then
      tmp="$work/ours-resized.png"
      convert "$icon_png" -resize "$px" "$tmp" 2>/dev/null || true
      # Normalised RMSE: 0 is identical, ~1 is unrelated.
      rmse=$(compare -metric RMSE "$tmp" "$slice" null: 2>&1 | sed -n 's/.*(\(.*\))/\1/p' || true)
      step "app icon" "${px} slice vs ours at the same size: RMSE ${rmse:-n/a} (0 = identical)"
    fi
    same=$(sha256sum "$slice" "$icon_png" | awk '{print $1}' | sort -u | wc -l | tr -d ' ')
    step "bytes" "identical file bytes: $([ "$same" = "1" ] && echo yes || echo no)"
  else
    step "app icon" "no PNG slice in app.icns; comparison skipped"
  fi
else
  step "app icon" "icon, app.icns or python3 missing; comparison skipped"
fi

# --- verdict ----------------------------------------------------------------

say "verdict"
printf '  %s\n' "A: $(count "$work/probes.disc") probes from the app, $n_a occurrence(s) in this tree"
printf '  %s\n' "B: $n_b_probes identifiers of ours, $n_b line(s) in the app's corpus"
printf '  %s\n' "reviewed overlaps: $explained explained, $unexplained unexplained"
if [ "$unexplained" -eq 0 ] && [ "$n_a" -eq 0 ] && [ "$n_b" -eq 0 ]; then
  printf '  %s\n' "clean: nothing of the app's is in the tree, and nothing of ours is in the app."
  printf '  %s\n' "method and numbers: docs/provenance.md"
  exit 0
fi
if [ "$unexplained" -eq 0 ]; then
  printf '  %s\n' "clean except for $explained reviewed overlap(s), each with a reason in"
  printf '  %s\n' "docs/provenance-reviewed.txt. Read them; they are the whole finding."
  exit 0
fi
printf '  %s\n' "NOT clean: $unexplained unexplained overlap(s) above. Do not ship until they are settled."
exit 1
