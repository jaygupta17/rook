#!/usr/bin/env bash
# Shared staging for the Linux packages (deb + AppImage).
#
# Sourced, not executed. Owns the layout under $STAGE and the measurements both
# build scripts report, so the two artefacts cannot drift apart.
#
# Layout produced (paths relative to $STAGE):
#   usr/lib/rook/rook                host shell (stripped, rpath $ORIGIN/cef)
#   usr/lib/rook/cef/                CEF 156 runtime (libcef.so stripped)
#   usr/lib/rook/node                Node 22 (the runtime is Node, not the distro's)
#   usr/lib/rook/runtime/            bridge + CLI, no npm deps
#   usr/lib/rook/sdk/                ego-browser SDK bundle, when vendor/ has one
#   usr/bin/rook                     launcher (self-relative lib dir)
#   usr/bin/ego-browser              launcher (execs bundled node + cli.js)
#   usr/share/applications/rook.desktop
#   usr/share/icons/hicolor/{48,64,128,256}x.../apps/rook.png
#   usr/share/doc/rook/{README.md,copyright,LICENSE,NOTICE}
#   usr/share/doc/rook/{sdk-LICENSE,cef-LICENSE.txt,cef-CREDITS.html.gz,node-LICENSE}

set -euo pipefail

pkg_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$pkg_dir/.." && pwd)"

# --- inputs (all overridable; nothing here writes outside $pkg_dir) -----------

ROOK_NODE="${ROOK_NODE:-}"
if [ -z "$ROOK_NODE" ]; then
  for candidate in /usr/local/bin/node22 /opt/node22/bin/node; do
    if [ -x "$candidate" ]; then ROOK_NODE="$candidate"; break; fi
  done
fi
if [ -z "$ROOK_NODE" ] && command -v node >/dev/null 2>&1; then
  ROOK_NODE="$(command -v node)"
fi

ROOK_HOST_BIN="${ROOK_HOST_BIN:-$repo_dir/host/build/bin/rook}"
ROOK_CEF_SOURCE="${ROOK_CEF_SOURCE:-$repo_dir/host/cef-runtime}"
# Only used to take LICENSE.txt and CREDITS.html from the exact distribution
# that is being shipped. packaging/assets holds the same two files, so a build
# without the distribution still produces a package that carries them.
ROOK_CEF_ROOT="${ROOK_CEF_ROOT:-}"
ROOK_RUNTIME_DIR="${ROOK_RUNTIME_DIR:-$repo_dir/runtime}"
ROOK_SDK_DIR="${ROOK_SDK_DIR:-$repo_dir/vendor/ego-browser/dist/out}"
ROOK_LOCALES="${ROOK_LOCALES:-en-US en-GB hi}"
ROOK_ARCH="${ROOK_ARCH:-$(dpkg --print-architecture 2>/dev/null || echo amd64)}"
ROOK_STRIP="${ROOK_STRIP:-1}"
ROOK_STRIP_NODE="${ROOK_STRIP_NODE:-1}"
ROOK_MAINTAINER="${ROOK_MAINTAINER:-Rook packaging <packaging@localhost>}"

# Payload names are fixed: the launchers and the CLI resolve them by name.
LIBDIR_NAME="rook"

work_dir="${ROOK_WORK_DIR:-$pkg_dir/work}"
cache_dir="$work_dir/cache"

# Measurements, filled in by the stage functions and printed by the callers.
declare -A sizes=()

say()  { printf '\n\033[1m[pkg]\033[0m %s\n' "$*"; }
step() { printf '  %-22s %s\n' "$1" "$2"; }
warn() { printf '\033[1m[pkg] warning\033[0m %s\n' "$*" >&2; }
die()  { printf '\n\033[1m[pkg] FAIL\033[0m %s\n' "$*" >&2; exit 1; }

# One unit everywhere: decimal MB (10^6 bytes), the way apt quotes disk usage.
# du -sk reports KiB, so multiply by 1.024 before dividing.
human() {
  du -sk "$1" 2>/dev/null | awk '{ k=$1; if (k >= 1000) printf "%.1f MB", k*1.024/1000; else printf "%d KB", k }'
}
bytes() { stat -c %s "$1" 2>/dev/null || echo 0; }

mb() { # bytes -> decimal MB
  awk -v b="$1" 'BEGIN { printf "%.0f MB", b / 1000000 }'
}

need_tool() {
  command -v "$1" >/dev/null 2>&1 || die "missing build tool: $1${2:+ ($2)}"
}

version() {
  if [ -n "${ROOK_VERSION:-}" ]; then printf '%s\n' "$ROOK_VERSION"; return; fi
  if [ -f "$pkg_dir/VERSION" ]; then head -1 "$pkg_dir/VERSION" | tr -d ' \n'; return; fi
  printf '0.0.0\n'
}

preflight() {
  need_tool dpkg-deb
  need_tool strip "binutils"
  need_tool patchelf
  need_tool rsvg-convert "librsvg2-bin"
  [ -n "$ROOK_NODE" ] && [ -x "$ROOK_NODE" ] || die "no Node 22 found; set ROOK_NODE=/path/to/node"
  local major
  major="$("$ROOK_NODE" -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 22 ] || die "Node 22+ required, $ROOK_NODE is v$major"
  [ -x "$ROOK_HOST_BIN" ] || die "host binary missing: $ROOK_HOST_BIN (build host/ first)"
  [ -f "$ROOK_CEF_SOURCE/libcef.so" ] || die "CEF runtime missing: $ROOK_CEF_SOURCE/libcef.so"
  for f in resources.pak icudtl.dat v8_context_snapshot.bin chrome-sandbox locales; do
    [ -e "$ROOK_CEF_SOURCE/$f" ] || die "CEF runtime incomplete: $ROOK_CEF_SOURCE/$f"
  done
  for f in chrome_100_percent.pak chrome_200_percent.pak; do
    [ -e "$ROOK_CEF_SOURCE/$f" ] || warn "CEF runtime has no $f (CEF will fail without it)"
  done
  [ -f "$ROOK_RUNTIME_DIR/cli.js" ] || die "bridge missing: $ROOK_RUNTIME_DIR/cli.js"
}

reset_stage() {
  if [ "${ROOK_KEEP_STAGE:-0}" = "1" ] && [ -d "$STAGE/usr" ]; then
    step "stage" "kept ($STAGE)"
  else
    rm -rf "$STAGE"
  fi
  mkdir -p "$STAGE/usr/lib/$LIBDIR_NAME" "$STAGE/usr/bin" \
           "$STAGE/usr/share/applications" "$STAGE/usr/share/doc/rook"
}

# --- components --------------------------------------------------------------

stage_host_binary() {
  local dest="$STAGE/usr/lib/$LIBDIR_NAME/rook"
  cp -f "$ROOK_HOST_BIN" "$dest"
  chmod 0755 "$dest"

  # The development tree gets an absolute rpath into host/cef-runtime plus `.`,
  # which a packaged app must not have: on a clean machine the absolute path is
  # gone (libcef.so would not be found at all) and `.` lets the *working
  # directory* win the libcef.so lookup. Rewrite it to the installed layout.
  patchelf --set-rpath '$ORIGIN/cef' "$dest"
  if readelf -d "$dest" | grep -E '(RPATH|RUNPATH)' | grep -q "$repo_dir"; then
    die "rpath still points into $repo_dir"
  fi

  if [ "$ROOK_STRIP" = "1" ]; then
    strip --strip-unneeded "$dest"
  fi
  sizes[host_bin]=$(bytes "$dest")
  step "host binary" "$(mb "${sizes[host_bin]}") (rpath \$ORIGIN/cef)"
}

# libcef.so ships unstripped at 1.4 GB. Stripping is the single biggest lever on
# the install budget, and it is slow enough (~6 s here, minutes on a slow disk)
# that the result is cached under work/cache and keyed on the source file.
stage_libcef() {
  local src="$ROOK_CEF_SOURCE/libcef.so" dest="$1/libcef.so"
  local stamp cache
  cache="$cache_dir/libcef.$ROOK_ARCH.stripped.so"
  stamp="$cache_dir/libcef.$ROOK_ARCH.stamp"
  local want
  want="$(bytes "$src"):$(stat -c %Y "$src")"

  mkdir -p "$cache_dir"
  if [ "$ROOK_STRIP" != "1" ]; then
    cp --reflink=auto -f "$src" "$dest"
    step "libcef.so" "$(human "$dest") (not stripped)"
  elif [ -f "$cache" ] && [ "$(cat "$stamp" 2>/dev/null)" = "$want" ]; then
    cp --reflink=auto -f "$cache" "$dest"
    step "libcef.so" "$(human "$dest") (stripped, cached)"
  else
    cp --reflink=auto -f "$src" "$dest" || cp -f "$src" "$dest"
    local before after t0 t1
    before=$(bytes "$dest")
    t0=$(date +%s)
    strip --strip-unneeded "$dest"
    t1=$(date +%s)
    after=$(bytes "$dest")
    printf '%s\n' "$want" > "$stamp"
    cp --reflink=auto -f "$dest" "$cache" || cp -f "$dest" "$cache"
    step "libcef.so" "$(mb "$before") -> $(mb "$after") in $((t1 - t0))s (strip -unneeded)"
  fi
  chmod 0644 "$dest"
  sizes[libcef]=$(bytes "$dest")
}

stage_cef() {
  local dest="$STAGE/usr/lib/$LIBDIR_NAME/cef"
  mkdir -p "$dest/locales"

  stage_libcef "$dest"

  # Everything CEF reads at startup from resources_dir_path, copied as-is.
  local f
  for f in resources.pak chrome_100_percent.pak chrome_200_percent.pak \
           icudtl.dat v8_context_snapshot.bin libvk_swiftshader.so \
           libvulkan.so.1 vk_swiftshader_icd.json; do
    if [ -e "$ROOK_CEF_SOURCE/$f" ]; then
      cp --reflink=auto -f "$ROOK_CEF_SOURCE/$f" "$dest/$f" || cp -f "$ROOK_CEF_SOURCE/$f" "$dest/$f"
    fi
  done
  chmod 0755 "$dest/libvk_swiftshader.so" "$dest/libvulkan.so.1" 2>/dev/null || true

  # CEF loads only the locales its --lang asks for; the other 217 .pak files are
  # 45 MB of dead weight.
  local kept=0 loc
  for loc in $ROOK_LOCALES; do
    if [ -f "$ROOK_CEF_SOURCE/locales/$loc.pak" ]; then
      cp -f "$ROOK_CEF_SOURCE/locales/$loc.pak" "$dest/locales/"
      kept=$((kept + 1))
    else
      warn "locale $loc.pak not in $ROOK_CEF_SOURCE/locales"
    fi
  done
  [ "$kept" -gt 0 ] || die "no locales staged"
  sizes[locales_src]=$(du -sk "$ROOK_CEF_SOURCE/locales" | cut -f1)
  sizes[locales_out]=$(du -sk "$dest/locales" | cut -f1)
  sizes[locale_count]=$(ls "$ROOK_CEF_SOURCE/locales" | wc -l | tr -d ' ')
  step "locales" "$kept of ${sizes[locale_count]} ($(human "$ROOK_CEF_SOURCE/locales") -> $(human "$dest/locales"))"

  # The setuid helper. dpkg-deb --root-owner-group records it as root:root; the
  # mode has to be set here because there is no fakeroot in the build path.
  cp -f "$ROOK_CEF_SOURCE/chrome-sandbox" "$dest/chrome-sandbox"
  chmod 4755 "$dest/chrome-sandbox"
  step "chrome-sandbox" "4755 (staged; the host uses it when it is usable)"

  sizes[cef]=$(du -sk "$dest" | cut -f1)
}

stage_node() {
  local dest="$STAGE/usr/lib/$LIBDIR_NAME/node"
  cp --reflink=auto -f "$ROOK_NODE" "$dest" || cp -f "$ROOK_NODE" "$dest"
  chmod 0755 "$dest"
  if [ "$ROOK_STRIP_NODE" = "1" ]; then
    strip --strip-unneeded "$dest"
  fi
  # The runtime uses Node's WebSocket, so prove the staged interpreter starts
  # rather than trusting cp.
  "$dest" -e 'if (!globalThis.WebSocket) process.exit(3)' ||
    die "staged node does not run ($dest)"
  sizes[node]=$(bytes "$dest")
  step "node" "$("$dest" -v), $(mb "${sizes[node]}")"
}

stage_runtime() {
  local dest="$STAGE/usr/lib/$LIBDIR_NAME/runtime"
  mkdir -p "$dest"
  cp -a "$ROOK_RUNTIME_DIR/." "$dest/"
  # Never ship a stray node_modules or editor droppings from the source tree.
  rm -rf "$dest/node_modules" "$dest/.DS_Store"
  [ -f "$dest/cli.js" ] || die "runtime/cli.js missing after copy"
  sizes[runtime]=$(du -sk "$dest" | cut -f1)
  step "runtime" "$(human "$dest") ($(find "$dest" -name '*.js' | wc -l | tr -d ' ') js files)"
}

stage_sdk() {
  local dest="$STAGE/usr/lib/$LIBDIR_NAME/sdk"
  mkdir -p "$dest"
  if [ -f "$ROOK_SDK_DIR/index.js" ]; then
    cp -a "$ROOK_SDK_DIR/." "$dest/"
    sizes[sdk]=$(du -sk "$dest" | cut -f1)
    step "sdk" "$(human "$dest") (from ${ROOK_SDK_DIR#$repo_dir/})"
  else
    # vendor/ is not in the tree yet: say so where a user will look, instead of
    # shipping an empty directory or silently pretending the SDK is bundled.
    cat > "$dest/README" <<'EOF'
The ego-browser SDK bundle is not included in this build.

The CLI and the bridge install here, but the SDK they drive (upstream's
dist/out/index.js) is built from an ego-browser checkout:

    npm ci && npm run build        # in package/ego-browser
    ego-browser nodejs --sdk-path /path/to/dist/out/index.js

or point EGO_BROWSER_SDK_PATH at that index.js once and forget it.
EOF
    sizes[sdk]=0
    step "sdk" "absent (no $ROOK_SDK_DIR/index.js); wrote sdk/README"
  fi
}

stage_launchers() {
  install -m 0755 "$pkg_dir/launcher/rook" "$STAGE/usr/bin/rook"
  install -m 0755 "$pkg_dir/launcher/ego-browser" "$STAGE/usr/bin/ego-browser"
  step "launchers" "/usr/bin/rook, /usr/bin/ego-browser (0755)"
}

stage_desktop() {
  install -m 0644 "$pkg_dir/assets/rook.desktop" \
    "$STAGE/usr/share/applications/rook.desktop"
  local size
  for size in 48 64 128 256; do
    local dir="$STAGE/usr/share/icons/hicolor/${size}x${size}/apps"
    mkdir -p "$dir"
    rsvg-convert -w "$size" -h "$size" "$pkg_dir/assets/rook.svg" -o "$dir/rook.png"
    chmod 0644 "$dir/rook.png"
  done
  # A third-party icon cache would otherwise keep the old image; there is none
  # in the package, which is why the per-size PNGs are all real sizes.
  step "icon" "256x256 $(du -h "$STAGE/usr/share/icons/hicolor/256x256/apps/rook.png" | cut -f1) PNG + 128/64/48 from assets/rook.svg"
}

stage_docs() {
  install -m 0644 "$pkg_dir/README.md" "$STAGE/usr/share/doc/rook/README.md"
  install -m 0644 "$pkg_dir/assets/copyright" "$STAGE/usr/share/doc/rook/copyright"
  install -m 0644 "$repo_dir/LICENSE" "$STAGE/usr/share/doc/rook/LICENSE"
  install -m 0644 "$repo_dir/NOTICE" "$STAGE/usr/share/doc/rook/NOTICE"
  stage_licences
  step "docs" "/usr/share/doc/rook: README.md, copyright, LICENSE, NOTICE, 4 licence texts"
}

# The licence text of every third-party thing in the payload. MIT and BSD-3
# both require the copyright notice and the permission text to accompany the
# distributed binary, so "the licence is in the upstream source" is not enough
# for a package: each component's own text ships here. CEF's CREDITS.html is the
# authoritative third-party attribution for the engine and is large; it ships
# too, because it is the list BSD-3 asks for.
#
# A text that sits next to the component wins over the checked-in copy, so the
# shipped text describes the exact bytes in the package even when the build tree
# has moved on from packaging/assets.
stage_licence() { # $1 = file name under /usr/share/doc/rook; $2.. = sources, best first
  local name="$1"; shift
  local dest="$STAGE/usr/share/doc/rook/$name" src
  for src in "$@"; do
    [ -n "$src" ] || continue
    if [ -s "$src" ]; then
      case "$name" in
        # The engine's credit list is 5 MB of HTML and 600 KB gzipped, and
        # /usr/share/doc prose is conventionally gzipped. Same file, same text.
        *.gz) gzip -9nc "$src" > "$dest"; chmod 0644 "$dest" ;;
        *)    install -m 0644 "$src" "$dest" ;;
      esac
      local shown="${src#"$repo_dir"/}"
      shown="${shown#"$pkg_dir"/}"
      step "$name" "$(awk -v b="$(bytes "$dest")" \
        'BEGIN { if (b >= 1000000) printf "%.1f MB", b/1000000; else printf "%d B", b }') from $shown"
      return 0
    fi
  done
  die "no $name text to ship; looked in: $*"
}

stage_licences() {
  # The SDK bundle is built from an upstream checkout, which carries the MIT
  # text at its root; a vendored copy usually has no licence of its own.
  stage_licence sdk-LICENSE \
    "$ROOK_SDK_DIR/LICENSE" "$ROOK_SDK_DIR/../LICENSE" \
    "$ROOK_SDK_DIR/../../LICENSE" "$ROOK_SDK_DIR/../../../LICENSE" \
    "$pkg_dir/assets/sdk-LICENSE"
  stage_licence cef-LICENSE.txt \
    "${ROOK_CEF_ROOT:+$ROOK_CEF_ROOT/LICENSE.txt}" \
    "$pkg_dir/assets/cef-LICENSE.txt"
  stage_licence cef-CREDITS.html.gz \
    "${ROOK_CEF_ROOT:+$ROOK_CEF_ROOT/CREDITS.html}" \
    "$pkg_dir/assets/cef-CREDITS.html"
  stage_licence node-LICENSE \
    "$(dirname "$(dirname "$ROOK_NODE")")/LICENSE" \
    "$pkg_dir/assets/node-LICENSE"
  sizes[licences]=$(du -sk "$STAGE/usr/share/doc/rook" | cut -f1)
}

stage_payload() {
  # $1 = staging root. Everything inside is owned by root:root in the archive.
  STAGE="$1"
  mkdir -p "$STAGE"
  reset_stage
  stage_host_binary
  stage_cef
  stage_node
  stage_runtime
  stage_sdk
  stage_launchers
  stage_desktop
  stage_docs

}

# --- reporting ---------------------------------------------------------------

installed_kb() { du -sk "$1/usr" | cut -f1; }

print_sizes() {
  local stage="$1" deb_bytes="${2:-0}"
  # The control file's Installed-Size is authoritative; reuse it when the caller
  # has it so the summary cannot disagree with the archive by a block.
  local total_kb="${ROOK_INSTALLED_KB:-$(installed_kb "$stage")}"
  say "sizes"
  step "host binary" "$(mb "${sizes[host_bin]:-0}")"
  step "libcef.so" "$(mb "${sizes[libcef]:-0}") (after strip)"
  step "cef payload" "$(awk -v k="${sizes[cef]:-0}" 'BEGIN{printf "%.0f MB", k/1000}')"
  step "  locales" "$(awk -v a="${sizes[locales_src]:-0}" -v b="${sizes[locales_out]:-0}" \
    'BEGIN{printf "%.0f MB -> %.1f MB", a/1000, b/1000}')"
  step "node" "$(mb "${sizes[node]:-0}")"
  step "runtime" "$(awk -v k="${sizes[runtime]:-0}" 'BEGIN{printf "%.1f MB", k/1000}')"
  if [ "${sizes[sdk]:-0}" = "0" ]; then
    step "sdk" "not bundled"
  else
    step "sdk" "$(awk -v k="${sizes[sdk]}" 'BEGIN{printf "%.1f MB", k/1000}')"
  fi
  step "licences" "$(awk -v k="${sizes[licences]:-0}" 'BEGIN{printf "%.1f MB", k/1000}') (CEF CREDITS.html is most of it)"
  step "installed size" "$(awk -v k="$total_kb" 'BEGIN{printf "%.0f MB (%d KiB)", k*1.024/1000, k}')"
  if [ "$deb_bytes" -gt 0 ]; then
    step "artifact" "$(mb "$deb_bytes")"
  fi

  # §6 says "≤ 450 MB" without a unit. apt quotes disk usage in 10^6 bytes, du
  # in MiB, so report against both readings instead of picking the flattering one.
  local budget_mb=450 used_dec used_mib
  used_dec=$(awk -v k="$total_kb" 'BEGIN{printf "%.1f", k*1.024/1000}')
  used_mib=$(awk -v k="$total_kb" 'BEGIN{printf "%.1f", k/1024}')
  if awk -v u="$used_dec" -v b="$budget_mb" 'BEGIN{exit !(u > b)}'; then
    warn "OVER budget: $used_dec MB installed vs ${budget_mb} MB (§6), by $(awk -v u="$used_dec" -v b="$budget_mb" 'BEGIN{printf "%.1f", u-b}') MB"
  else
    step "budget" "$used_dec of ${budget_mb} MB (§6): $(awk -v u="$used_dec" -v b="$budget_mb" 'BEGIN{printf "%.1f", b-u}') MB spare; $used_mib MiB if read as du"
  fi
}
