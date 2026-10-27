#!/usr/bin/env bash
# Build the AppImage: packaging/out/rook-<version>-<arch>.AppImage
#
# Same staged payload as the .deb (common.sh), wrapped in an AppDir. The only
# difference that matters: the launchers resolve their library directory from
# their own path, so they work both under /usr and inside an AppImage mount.
#
# appimagetool is not in this box's package set, so it is fetched from the
# project's continuous release into packaging/work/tools and run with
# APPIMAGE_EXTRACT_AND_RUN=1 (no FUSE in this container). If it cannot be
# fetched, this script prints SKIPPED and produces no artifact: a half-written
# AppImage that fails on someone's desktop is worse than none.
#
#   packaging/build-appimage.sh
#   ROOK_SKIP_FETCH=1 packaging/build-appimage.sh   # offline: use a local tool only
set -euo pipefail

# shellcheck source=common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

VERSION="$(version)"
OUT_DIR="$pkg_dir/out"
APPDIR="$work_dir/appdir"
TOOLS="$work_dir/tools"

# AppImage names its architectures differently from dpkg, and the release only
# publishes those names (appimagetool-x86_64.AppImage, not -amd64).
case "$ROOK_ARCH" in
  amd64) APPIMAGE_ARCH=x86_64 ;;
  arm64) APPIMAGE_ARCH=aarch64 ;;
  armhf) APPIMAGE_ARCH=armhf ;;
  i386)  APPIMAGE_ARCH=i686 ;;
  *)     APPIMAGE_ARCH="$ROOK_ARCH" ;;
esac
TOOL="$TOOLS/appimagetool-$APPIMAGE_ARCH.AppImage"
URL="https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-$APPIMAGE_ARCH.AppImage"

skip() {
  printf '\n\033[1m[pkg] SKIPPED\033[0m %s\n' "$*"
  printf '        no AppImage was produced.\n'
  exit 0
}

say "preflight"
preflight
step "version" "$VERSION"
step "arch" "$ROOK_ARCH (AppImage: $APPIMAGE_ARCH)"

say "appimagetool"
if [ -x "$TOOL" ]; then
  step "tool" "$TOOL (cached)"
elif [ "${ROOK_SKIP_FETCH:-0}" = "1" ]; then
  skip "appimagetool not available and ROOK_SKIP_FETCH=1 (no download attempted)"
elif command -v appimagetool >/dev/null 2>&1; then
  TOOL="$(command -v appimagetool)"
  step "tool" "$TOOL (from PATH)"
else
  mkdir -p "$TOOLS"
  step "fetch" "$URL"
  if ! curl -fsSL --retry 2 --connect-timeout 15 -o "$TOOL.part" "$URL"; then
    rm -f "$TOOL.part"
    skip "appimagetool could not be fetched (offline, or GitHub unreachable) and is not installed"
  fi
  size=$(stat -c %s "$TOOL.part")
  if [ "$size" -lt 1000000 ]; then
    rm -f "$TOOL.part"
    skip "the appimagetool download was only $size bytes; not trusting it"
  fi
  mv "$TOOL.part" "$TOOL"
  chmod 0755 "$TOOL"
  step "fetched" "$(du -h "$TOOL" | cut -f1)"
fi

tool_out=$(APPIMAGE_EXTRACT_AND_RUN=1 "$TOOL" --version 2>&1) || tool_out=""
if [ -z "$tool_out" ]; then
  tool_out=$(APPIMAGE_EXTRACT_AND_RUN=1 "$TOOL" --help 2>&1) || tool_out=""
fi
[ -n "$tool_out" ] || skip "appimagetool at $TOOL does not run on this system"
step "version" "$(printf '%s\n' "$tool_out" | head -1)"

say "stage"
stage_payload "$APPDIR"

# AppRun: the AppImage entry point. It execs the same launcher the .deb installs.
cat > "$APPDIR/AppRun" <<'EOF'
#!/bin/sh
# AppImage entry point. The launcher next to this one resolves usr/lib/rook
# from its own path, so nothing here needs the mount point.
set -u
here=$(dirname -- "$(readlink -f -- "$0")")
exec "$here/usr/bin/rook" "$@"
EOF
chmod 0755 "$APPDIR/AppRun"

install -m 0644 "$pkg_dir/assets/rook.desktop" "$APPDIR/rook.desktop"
install -m 0644 "$APPDIR/usr/share/icons/hicolor/256x256/apps/rook.png" "$APPDIR/rook.png"

say "appimagetool"
mkdir -p "$OUT_DIR"
appimage="$OUT_DIR/rook-${VERSION}-${APPIMAGE_ARCH}.AppImage"
rm -f "$appimage"
t0=$(date +%s)
set +e
APPIMAGE_EXTRACT_AND_RUN=1 ARCH="$APPIMAGE_ARCH" "$TOOL" --no-appstream "$APPDIR" "$appimage" \
  >"$work_dir/appimage.log" 2>&1
rc=$?
set -e
tail -12 "$work_dir/appimage.log" | sed 's/^/    /'
[ "$rc" -eq 0 ] || { printf '\n\033[1m[pkg] FAIL\033[0m appimagetool exited %s (log: %s)\n' "$rc" "$work_dir/appimage.log" >&2; exit 1; }
[ -s "$appimage" ] || { printf '\n\033[1m[pkg] FAIL\033[0m appimagetool reported success but wrote no file\n' >&2; exit 1; }
t1=$(date +%s)
chmod 0755 "$appimage"
step "built" "$appimage in $((t1 - t0))s"

print_sizes "$APPDIR" "$(stat -c %s "$appimage")"

printf '\n\033[1m[pkg] OK\033[0m  %s\n' "$appimage"
printf '        run: chmod +x %s && ./%s\n' "$(basename "$appimage")" "$(basename "$appimage")"
