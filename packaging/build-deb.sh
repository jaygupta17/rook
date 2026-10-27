#!/usr/bin/env bash
# Build the Debian package: packaging/out/rook_<version>_<arch>.deb
#
# Inputs are the already-built host binary and the CEF runtime (see common.sh
# for the overrides). Nothing outside packaging/ is written.
#
#   packaging/build-deb.sh
#   ROOK_VERSION=0.3.1 ROOK_DEB_COMPRESS=zstd packaging/build-deb.sh   # fast loop
#   ROOK_KEEP_STAGE=1 packaging/build-deb.sh                          # keep work/
#
# Requires: dpkg-deb, strip, patchelf, rsvg-convert, Node 22 (ROOK_NODE).
set -euo pipefail

# shellcheck source=common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

VERSION="$(version)"
DEB_NAME="rook_${VERSION}_${ROOK_ARCH}.deb"
OUT_DIR="$pkg_dir/out"
STAGE_ROOT="$work_dir/deb-root"
COMPRESS="${ROOK_DEB_COMPRESS:-xz}"

case "$COMPRESS" in
  xz)   COMPRESS_ARGS=(-Zxz -z6) ;;
  zstd) COMPRESS_ARGS=(-Zzstd -z19) ;;
  gzip) COMPRESS_ARGS=(-Zgzip -z6) ;;
  *)    die "ROOK_DEB_COMPRESS must be xz, zstd or gzip (got $COMPRESS)";;
esac

# Runtime dependencies, one line per soname that rook or libcef.so actually
# links against. Verified by packaging/verify-deb.sh, which maps every NEEDED
# entry back to a package and fails if one is not covered here.
#
# The t64 variants are the Ubuntu 24.04 / Debian 13 names from the 64-bit
# time_t transition; the alternatives keep the package installable on Debian 12
# and Ubuntu 22.04.
DEB_DEPENDS="libc6 (>= 2.38),
 libstdc++6 (>= 13),
 libgtk-3-0t64 | libgtk-3-0,
 libnss3,
 libnspr4,
 libx11-6,
 libxcomposite1,
 libxdamage1,
 libxrandr2,
 libxext6,
 libxfixes3,
 libxcb1,
 libgbm1,
 libdrm2,
 libasound2t64 | libasound2,
 libatk1.0-0t64 | libatk1.0-0,
 libatk-bridge2.0-0t64 | libatk-bridge2.0-0,
 libatspi2.0-0t64 | libatspi2.0-0,
 libcups2t64 | libcups2,
 libxkbcommon0,
 libpango-1.0-0,
 libcairo2,
 libglib2.0-0t64 | libglib2.0-0,
 libdbus-1-3,
 libexpat1,
 libudev1,
 libgcc-s1,
 fonts-liberation"

say "preflight"
preflight
step "version" "$VERSION"
step "arch" "$ROOK_ARCH"
step "node" "$ROOK_NODE ($("$ROOK_NODE" -v))"
step "host binary" "$ROOK_HOST_BIN ($(human "$ROOK_HOST_BIN"))"
step "cef runtime" "$ROOK_CEF_SOURCE ($(human "$ROOK_CEF_SOURCE"))"
if [ -f "$ROOK_SDK_DIR/index.js" ]; then
  step "sdk" "$ROOK_SDK_DIR"
else
  step "sdk" "none (vendor/ego-browser/dist/out is absent)"
fi

say "stage"
stage_payload "$STAGE_ROOT"

say "control"
mkdir -p "$STAGE_ROOT/DEBIAN"
INSTALLED_KB=$(installed_kb "$STAGE_ROOT")
export ROOK_INSTALLED_KB="$INSTALLED_KB"
cat > "$STAGE_ROOT/DEBIAN/control" <<EOF
Package: rook
Version: $VERSION
Architecture: $ROOK_ARCH
Maintainer: $ROOK_MAINTAINER
Installed-Size: $INSTALLED_KB
Depends: $DEB_DEPENDS
Section: web
Priority: optional
Description: agent browser with isolated spaces for agent work
 Rook is a web browser built around agent work: the window you browse in,
 plus separate spaces that agents drive. Each space is its own Chromium storage
 context, so an agent session never sees the cookies of the space you use, and
 a handoff can move a space between the two.
 .
 This package is a GTK3 shell around the stock Chromium engine (CEF 156). The
 ego-browser command runs the agent runtime on the Node.js interpreter bundled
 here, so no separate Node install is needed or used.
 .
 The setuid sandbox helper is installed setuid root, and the app enables
 Chromium's sandbox when that helper or unprivileged user namespaces are
 usable. A machine with neither prints a warning and runs unsandboxed. See
 /usr/share/doc/rook/README.md for what that means and how to check it.
EOF
chmod 0644 "$STAGE_ROOT/DEBIAN/control"
step "control" "Installed-Size: $INSTALLED_KB KiB, $(printf '%s' "$DEB_DEPENDS" | tr ',' '\n' | grep -c .) dependencies"
step "compression" "$COMPRESS"

say "dpkg-deb"
mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR/$DEB_NAME"
t0=$(date +%s)
# --root-owner-group: the archive records root:root without needing fakeroot or
# real privileges; the 4755 mode on chrome-sandbox is set in the staging tree.
dpkg-deb --root-owner-group "${COMPRESS_ARGS[@]}" --build "$STAGE_ROOT" "$OUT_DIR/$DEB_NAME"
t1=$(date +%s)
step "built" "$OUT_DIR/$DEB_NAME in $((t1 - t0))s"

print_sizes "$STAGE_ROOT" "$(bytes "$OUT_DIR/$DEB_NAME")"
printf '\n'

say "package"
dpkg-deb -I "$OUT_DIR/$DEB_NAME" | sed -e 's/^/  /' -e '/^  [A-Za-z].*:/!{s/^  $//}'

if [ "${ROOK_KEEP_STAGE:-0}" != "1" ]; then
  # The staging tree duplicates ~350 MB of payload; the package is the artefact.
  rm -rf "$STAGE_ROOT"
  step "stage" "removed (ROOK_KEEP_STAGE=1 keeps it)"
fi

printf '\n\033[1m[pkg] OK\033[0m  %s\n' "$OUT_DIR/$DEB_NAME"
printf '        archive %s, installed %s (%s KiB)\n' \
  "$(human "$OUT_DIR/$DEB_NAME")" "$(awk -v k="$INSTALLED_KB" 'BEGIN{printf "%.0f MB", k*1.024/1000}')" "$INSTALLED_KB"
