#!/bin/sh
# Build the Linux-patched ego-browser SDK from an upstream checkout.
#
#   scripts/build-sdk.sh [--upstream <dir>]
#
# The reference checkout is never modified. The script
#   1. copies `package/ego-browser` into `vendor/ego-browser` and
#      `skills/ego-browser` into `vendor/skills` (its build reads the latter),
#   2. applies every `patches/*.patch` in filename order,
#   3. runs the package's own build.
#
# The result is a normal SDK directory: `vendor/ego-browser/dist/out/index.js`
# with the usage guide beside it at `dist/out/ego-browser/SKILL.md`, which is
# exactly what `--sdk-path` and `ego-browser skill` read. Nothing is installed
# into this repo's own `dist/`: that path belongs to the CLI's "no SDK" error.
#
# `vendor/UPSTREAM` records what was built and from which commit, and
# `vendor/SDK_PATH` holds the SDK path for scripts to consume.
#
# Env: ROOK_UPSTREAM (upstream package dir), ROOK_NODE (node >= 22 binary).

set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
upstream=${ROOK_UPSTREAM:-}
run_build=1

usage() {
    sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
    case $1 in
        --upstream) upstream=$2; shift 2 ;;
        --upstream=*) upstream=${1#*=}; shift ;;

        -h|--help) usage; exit 0 ;;
        *) echo "build-sdk: unknown argument: $1" >&2; usage >&2; exit 2 ;;
    esac
done

die() {
    echo "build-sdk: $*" >&2
    exit 1
}

[ -n "$upstream" ] || die "pass --upstream <checkout>/package/ego-browser (or set ROOK_UPSTREAM)"
[ -d "$upstream" ] || die "no upstream package at $upstream (set ROOK_UPSTREAM)"
[ -f "$upstream/package.json" ] || die "$upstream does not look like package/ego-browser"
# The package build reads ../../skills/ego-browser, so the copy has to keep the
# same repo -> package/ego-browser depth. In vendor/ that is vendor/ego-browser.
source_repo=$(CDPATH= cd -- "$upstream/../.." && pwd)
[ -d "$source_repo/skills/ego-browser" ] ||
    die "no $source_repo/skills/ego-browser (needed by the package build)"

# Node >= 22: the package build and the runtime both need it.
find_node() {
    for candidate in "${ROOK_NODE:-}" node /usr/local/bin/node22 /opt/node22/bin/node; do
        [ -n "$candidate" ] || continue
        command -v "$candidate" >/dev/null 2>&1 || continue
        major=$("$candidate" -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)
        [ -n "$major" ] || continue
        if [ "$major" -ge 22 ] 2>/dev/null; then
            command -v "$candidate"
            return 0
        fi
    done
    return 1
}
node_bin=$(find_node) || die "needs Node.js >= 22 (set ROOK_NODE=/path/to/node22)"

vendor=$here/vendor
package=$vendor/ego-browser

echo "== copy =="
rm -rf "$vendor/skills"
mkdir -p "$vendor" "$vendor/skills" "$package"
# Replace the sources but keep an existing install: node_modules is 68 MB and
# only the build needs it.
find "$package" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
# Copy sources, not build output: a stale dist/ must never leak into a patch run.
mkdir -p "$package"
tar -C "$upstream" \
    --exclude=./dist \
    --exclude=./artifacts \
    --exclude=./node_modules \
    --exclude=./.build.lock \
    -cf - . | tar -C "$package" -xf -
cp -a "$source_repo/skills/ego-browser" "$vendor/skills/ego-browser"
if [ -f "$package/node_modules/.package-lock.json" ]; then
    :
elif [ -d "$upstream/node_modules" ]; then
    cp -a "$upstream/node_modules" "$package/node_modules"
else
    echo "no node_modules in $upstream; installing"
    (cd "$package" && npm ci --no-audit --no-fund)
fi

echo "== patch =="
applied=""
for patch_file in "$here"/patches/*.patch; do
    [ -f "$patch_file" ] || die "no patches/*.patch found"
    name=$(basename "$patch_file")
    if (cd "$package" && git apply -p1 --whitespace=nowarn "$patch_file") 2>/dev/null; then
        :
    elif (cd "$package" && patch -p1 --forward --batch --silent <"$patch_file"); then
        :
    else
        die "$name does not apply to $upstream (already applied? patch series out of date?)"
    fi
    applied="$applied $name"
    echo "applied $name"
done

if [ "$run_build" = 1 ]; then
    echo "== build =="
    # `vendor/` has no repo around it, so the build is told where the entry
    # skill lives (patches/0002).
    (cd "$package" && EGO_BROWSER_BUILD_ROOT="$vendor" "$node_bin" scripts/build.mjs) ||
        die "the SDK build failed"
fi

[ -f "$package/dist/out/index.js" ] || die "the build produced no dist/out/index.js"
[ -f "$package/dist/out/ego-browser/SKILL.md" ] ||
    die "the build produced no dist/out/ego-browser/SKILL.md"

commit=$(git -C "$source_repo" rev-parse HEAD 2>/dev/null || echo unknown)
describe=$(git -C "$source_repo" describe --tags --always 2>/dev/null || echo unknown)
branch=$(git -C "$source_repo" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)
dirty=$(git -C "$source_repo" status --porcelain 2>/dev/null | head -1 || true)

cat >"$vendor/UPSTREAM" <<EOF
source: $source_repo
package: $upstream
commit: $commit
describe: $describe
branch: $branch
dirty: $([ -n "$dirty" ] && echo yes || echo no)
patches:$applied
built: $(date -u +%Y-%m-%dT%H:%M:%SZ)
node: $("$node_bin" -v)
sdk: $package/dist/out/index.js
skill: $package/dist/out/ego-browser/SKILL.md
EOF

printf '%s\n' "$package/dist/out/index.js" >"$vendor/SDK_PATH"

echo "== done =="
cat "$vendor/UPSTREAM"
echo
echo "sdk:   $package/dist/out/index.js"
echo "run:   $here/bin/ego-browser nodejs --sdk-path $package/dist/out/index.js -e '...'"
echo "or:    export EGO_BROWSER_SDK_PATH=$package/dist/out/index.js"
echo "skill: $here/bin/ego-browser skill --sdk-path $package/dist/out/index.js | head"
