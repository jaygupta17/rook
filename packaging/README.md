# Packaging — the Linux deliverables

Two artefacts, both built from the already-built host binary and the staged CEF
runtime. Everything here writes inside `packaging/` only: no `sudo`, no system
install, no edits to `host/`, `runtime/`, `bin/`, `test/`, `patches/` or `vendor/`.

| Artefact | Script | Size |
| --- | --- | --- |
| `out/rook_<version>_amd64.deb` | `build-deb.sh` | 138 MB, 444 MB installed |
| `out/rook-<version>-x86_64.AppImage` | `build-appimage.sh` | 173 MB (zstd squashfs, same payload) |

Both were built here (Ubuntu 24.04, amd64); the `.deb` was verified end to end
with `verify-deb.sh` and the AppImage was smoke-run under Xvfb.

```
packaging/
├── common.sh            shared staging + measurements (sourced)
├── build-deb.sh         .deb
├── build-appimage.sh    AppImage
├── verify-deb.sh        unpack + render + CLI round + dependency audit
├── VERSION              package version (ROOK_VERSION overrides)
├── assets/
│   ├── rook.svg     icon source, drawn for this package
│   ├── rook-256.png a 256 px render of it, for previews
│   ├── rook.desktop
│   ├── copyright        the package's Debian copyright file
│   ├── sdk-LICENSE      ego-browser SDK, MIT, verbatim upstream
│   ├── cef-LICENSE.txt  CEF, BSD-3, verbatim upstream
│   ├── cef-CREDITS.html the engine's credit list, gzipped into the package
│   └── node-LICENSE     Node.js, MIT, verbatim upstream
├── launcher/
│   ├── rook         -> /usr/bin/rook
│   └── ego-browser      -> /usr/bin/ego-browser
├── out/                 artefacts
└── work/                staging, strip cache, verification roots
```

## Build

Needs, on top of what `host/` already needs to build:

| Tool | Why | Package |
| --- | --- | --- |
| `dpkg-deb` | builds the archive, prints metadata | `dpkg` |
| `strip` | shrinks `libcef.so` (1476 MB → 277 MB) | `binutils` |
| `patchelf` | rewrites the binary's rpath to `$ORIGIN/cef` | `patchelf` |
| `rsvg-convert` | SVG → the four PNG icon sizes | `librsvg2-bin` |
| Node 22 | the bundled interpreter | `ROOK_NODE` |

```sh
packaging/build-deb.sh          # -> packaging/out/rook_0.3.0~m3_amd64.deb   (~50 s)
packaging/build-appimage.sh     # -> packaging/out/rook-0.3.0~m3-amd64.AppImage
packaging/verify-deb.sh         # unpack the newest .deb and prove it renders
```

The first `.deb` build spends ~6 s stripping `libcef.so`; the result is cached in
`work/cache/` keyed on the source file's size and mtime, so later builds reuse it.
`ROOK_KEEP_STAGE=1` keeps `work/deb-root` for inspection.

Inputs, all overridable:

| Variable | Default |
| --- | --- |
| `ROOK_VERSION` | `VERSION` file (`0.3.0~m3`, the version the host prints) |
| `ROOK_NODE` | first of `/usr/local/bin/node22`, `/opt/node22/bin/node`, `node` on `PATH` |
| `ROOK_HOST_BIN` | `host/build/bin/rook` |
| `ROOK_CEF_SOURCE` | `host/cef-runtime` |
| `ROOK_RUNTIME_DIR` | `runtime/` |
| `ROOK_SDK_DIR` | `vendor/ego-browser/dist/out` |
| `ROOK_LOCALES` | `en-US en-GB hi` |
| `ROOK_ARCH` | `dpkg --print-architecture` |
| `ROOK_STRIP`, `ROOK_STRIP_NODE` | `1` |
| `ROOK_DEB_COMPRESS` | `xz` (`zstd` makes iteration much faster; needs dpkg ≥ 1.21.18) |
| `ROOK_WORK_DIR` | `packaging/work` |

The version is `0.3.0~m3`, from the host's own banner (`0.3.0-M3`); `~m3` sorts
before a final `0.3.0`, so a real release upgrades over this package. The root
`package.json` version (`0.1.0`) is the JS runtime's and is not used here.

## Installed layout

```
/usr/bin/rook                     launcher: CEF paths, then exec the binary
/usr/bin/ego-browser              launcher: exec the bundled node on cli.js
/usr/lib/rook/rook                GTK3 + CEF shell, stripped (994 KB, rpath $ORIGIN/cef)
/usr/lib/rook/cef/libcef.so       Chromium 156, stripped (277 MB)
/usr/lib/rook/cef/*.pak           resources.pak (24 MB) + chrome_{100,200}_percent.pak
/usr/lib/rook/cef/icudtl.dat      ICU data (11 MB), resolved beside libcef.so
/usr/lib/rook/cef/v8_context_snapshot.bin
/usr/lib/rook/cef/locales/        en-US, en-GB, hi
/usr/lib/rook/cef/chrome-sandbox  setuid 4755 root:root — used when usable
/usr/lib/rook/cef/libvk_swiftshader.so, libvulkan.so.1, vk_swiftshader_icd.json
/usr/lib/rook/node                Node 22, stripped (107 MB)
/usr/lib/rook/runtime/            bridge + CLI, plain ESM, no npm deps
/usr/lib/rook/sdk/                the ego-browser SDK bundle (vendor/ego-browser/dist/out)
/usr/share/applications/rook.desktop
/usr/share/icons/hicolor/{48,64,128,256}x.../apps/rook.png
/usr/share/doc/rook/{README.md,copyright,LICENSE,NOTICE}
/usr/share/doc/rook/{sdk-LICENSE,cef-LICENSE.txt,cef-CREDITS.html.gz,node-LICENSE}
```

Both launchers resolve `usr/lib/rook` from their own path (`readlink -f $0`),
not from a hardcoded `/usr`, so the same files work installed, unpacked under a
temp root, and inside an AppImage mount. `ROOK_LIB` overrides the directory.

`ego-browser` sets `EGO_BROWSER_SDK_PATH` to the bundled `sdk/index.js` when one
exists, and always `exec`s (no wrapper child) because the SDK keys its page
ledger on the parent pid — a wrapper would break page labels between rounds. It
also overrides `ROOK_NODE`, so a user's own Node can be substituted.

## Sizes

Measured on this box, `0.3.0~m3`, amd64:

| Block | Source | Packaged | How |
| --- | --- | --- | --- |
| `libcef.so` | 1476 MB | 277 MB | `strip --strip-unneeded` |
| `locales/` | 220 files, 51 MB | 3 files, 2.7 MB | pruned to `ROOK_LOCALES` |
| `node` | 125 MB | 107 MB | `strip --strip-unneeded` |
| host `rook` | 1.4 MB | 1.0 MB | rpath rewritten, stripped |
| `runtime/` | 188 KB | 188 KB | copied as-is |
| `sdk/` | 1.1 MB | 1.1 MB | copied as-is |
| licence texts | — | 0.8 MB | 4 upstream files; `CREDITS.html` gzipped |
| **installed** | — | **444 MB** (434,040 KiB = 424 MiB) | `du -sk usr`, the `Installed-Size` field |
| **.deb** | — | **138 MB** | xz -6 |
| **AppImage** | — | **173 MB** | zstd squashfs |

Budget is 450 MB installed (`bench/report.md`): **5.5 MB
spare** if MB means 10^6 bytes (which is what `apt` prints: "After this
operation, 444 MB of additional disk space will be used"), or **26 MiB spare**
if the line is read in `du`'s MiB. Both readings fit, but only just. The headroom is thin, and the three removable blocks, largest first, are
Node (107 MB — cannot go: the bridge needs Node ≥ 22 and Ubuntu 24.04 ships 18),
`resources.pak` (24 MB — CEF will not start without it) and SwANGLE
(`libvk_swiftshader.so` 15 MB + `libvulkan.so.1` 1.5 MB, only used with
`ROOK_GPU=1`). If the budget ever needs real room, the lever is architectural —
host the bridge in the distro's Node and drop the bundled interpreter — not a
packaging trick.

## AppImage

```sh
packaging/build-appimage.sh
# -> packaging/out/rook-0.3.0~m3-x86_64.AppImage (173 MB)

chmod +x packaging/out/rook-0.3.0~m3-x86_64.AppImage
packaging/out/rook-0.3.0~m3-x86_64.AppImage
```

`appimagetool` is not installed on this box, so the script fetches the official
continuous build (`appimagetool-x86_64.AppImage`, 15 MB) into `work/tools/` and
runs it with `APPIMAGE_EXTRACT_AND_RUN=1`, since there is no FUSE here. If the
download fails, or the tool will not run, the script prints `SKIPPED` with the
reason and produces no file: a half-built AppImage is worse than none.

The AppDir is the same staged payload plus `AppRun`, `rook.desktop` and
`rook.png` at the root. What differs from the `.deb`:

- no desktop integration — nothing lands in the applications menu or icon theme
  unless the user runs an AppImage integration tool;
- the setuid sandbox helper cannot work: the squashfs mount is `nosuid`, so
  `chrome-sandbox` is inert there; the host detects that and uses the
  user-namespace sandbox instead, or warns and runs unsandboxed when that is
  blocked too;
- smoke test used here, the same way the `.deb` is verified:
  `APPIMAGE_EXTRACT_AND_RUN=1 ./rook-0.3.0~m3-x86_64.AppImage --screenshot /tmp/x.png`
  on a private Xvfb → 1280x820 PNG, exit 0.

## Install and first run

```sh
sudo apt install ./rook_0.3.0~m3_amd64.deb
rook
```

`apt` resolves dependencies from `DEBIAN/control`: `libc6 (>= 2.38)`,
`libstdc++6 (>= 13)`, GTK3, NSS/NSPR, X11 + Xcomposite/Xdamage/Xrandr/Xext/Xfixes/
xcb, GBM, DRM, ALSA, ATK + AT-SPI, cups, xkbcommon, pango, cairo, glib, dbus,
expat, udev, libgcc, fonts-liberation. `verify-deb.sh` fails if any soname either
binary links against is not covered by that list.

On first start the app creates `~/.local/share/rook/profiles/default/` and
listens on `$XDG_RUNTIME_DIR/rook-<uid>.sock` (mode 0600). The window needs
an X server; on a Wayland session GTK goes through XWayland automatically because
this CEF build ships only the X11 Ozone platform. `ego-browser backend` reports
which browser a task would use — with `rook` running it says `host`.

The desktop entry is `Exec=rook` with no `%U`: the app parses `--url` for a
single URL and hands anything else to CEF, which ignores it. Add a URL handler to
the `.desktop` only once the app parses one.

## Sandbox: on when the machine can run it

The host decides at startup, in this order, and prints exactly one line saying
which path it took:

1. `ROOK_NO_SANDBOX=1` — off, with a warning that names the risk.
2. Running as root — off with a warning (Chromium will not sandbox as root).
3. `chrome-sandbox` is a regular file, owned by uid 0, mode 4755, executable —
   Chromium's setuid sandbox, the path the `.deb` install takes.
4. Unprivileged user namespaces actually work (a real `unshare` + uid/gid map
   probe, not a container sniff) — Chromium's namespace sandbox. This is what a
   normal desktop and the AppImage use.
5. Otherwise — off, with a single `[rook] WARNING:` line giving the reason and
   the fix. `ROOK_NO_SANDBOX=0` turns that case into a hard exit 4 instead.

Check any machine without launching the UI:

```sh
ROOK_SANDBOX_PROBE=1 rook
```

`ROOK_NO_SANDBOX=0` refuses to start rather than run unsandboxed. In an
AppImage the helper can never work (`nosuid` mount), so it is the namespace path
or the warning.

What the packaging verification can and cannot prove: `dpkg-deb -x` extracts as
your user, so root ownership of the helper is lost and the extracted tree takes
the namespace path. Only a real `dpkg -i` exercises the setuid helper's exec.

## Verify

```sh
packaging/verify-deb.sh                      # private Xvfb, nothing installed
ROOK_DISPLAY=:99 packaging/verify-deb.sh      # use an existing display instead
```

What it does, in order:

1. `dpkg-deb -I` fields, entry count, payload; `dpkg-deb -c` modes — asserts
   `chrome-sandbox` is `-rwsr-xr-x root/root` and both launchers are `-rwxr-xr-x`.
2. `dpkg-deb -x` into `work/verify/root` and checks the payload files exist, the
   extracted `libcef.so` is stripped, and the binary's rpath is `$ORIGIN/cef`.
3. Runs the **unpacked** launcher with `--screenshot` and `--verify-isolation`
   against a local fixture server: 1280x820 PNG, ≥500 colours, non-flat, ≥1 page
   loaded over HTTP, and the two spaces reporting different `localStorage` and
   cookies. Then greps `/proc/<pid>/maps` to prove the loaded `libcef.so` is the
   packaged one — the host binary still carries a compiled-in build-tree default,
   so a run without the launcher would silently load `host/cef-runtime` instead.
   It also requires one sandbox decision line in the run log
   (`[rook] sandbox: enabled …` or `[rook] WARNING: Chromium sandbox disabled …`).
4. Drives one real agent round through the packaged `ego-browser` (bundled node +
   bridge + SDK) against the unpacked app and asserts a snapshot comes back.
5. Maps every `NEEDED` soname of both binaries to the package that owns it and
   fails if `Depends` does not cover it; also fails if the app's log references
   the build tree.

By default it starts its own Xvfb (`:95` upwards), because `:99` is shared with
whatever else runs QA here and `import -window` grabs a screen rectangle of the
window: an overlapping app produces a screenshot of *that* app. Pass
`ROOK_DISPLAY` to reuse a display anyway; it then reports how many windows are
mapped.

## First-install gotchas

- **Needs glibc ≥ 2.38 and libstdc++ ≥ 13** (Ubuntu 23.10+, Debian 13). The host
  is built on Ubuntu 24.04 and references `GLIBC_2.38`/`GLIBCXX_3.4.31`; on
  Ubuntu 22.04 (glibc 2.35) the binary dies with `version 'GLIBC_2.38' not found`.
  The control file encodes the floor, so `apt` refuses rather than installing
  something that cannot start. The `t64 | plain` alternatives on GTK/NSS/ALSA
  style names only handle package *renames*, not this floor.
- **X11 only.** No Wayland-native Ozone in this CEF build; Wayland sessions go
  through XWayland. With no X server at all the app exits with `no usable
  display`, which is the intended message.
- **Three UI languages.** en-US, en-GB, hi. Other locales fall back to English
  chrome; content languages are unaffected. Widen with `ROOK_LOCALES`.
- **Node is private** (`/usr/lib/rook/node`); `/usr/bin/node` is never touched,
  so an existing Node install is unaffected. `ROOK_NODE` overrides it.
- **A GNOME keyring prompt can appear on first launch** ("Choose password for new
  keyring"): Chromium's password store asks libsecret for the default collection
  and this box's gnome-keyring has none. It is the desktop's dialog, not the
  app's, and choosing Cancel is safe. To suppress it, launch with
  `ROOK_CEF_EXTRA_FLAGS=password-store=basic` (verified: the dialog disappears and
  the window renders normally). On a normal desktop the keyring already exists.
- **Uninstalling keeps your data.** `~/.local/share/rook/` (profiles, space
  storage) and `~/.config/rook/state` (bridge state) survive `apt remove`; that
  is deliberate, but it means a "clean reinstall" is not clean.
- **`chrome-sandbox` is setuid.** `dpkg` keeps the bit; `dpkg-deb -x` or
  `tar -x` as a non-root user cannot restore root ownership (the mode survives,
  the owner does not). Expected, and the verify script says which it saw. A tree
  extracted that way therefore takes the user-namespace path, not the setuid one.
- **No URL handler, no auto-update, no signed repository.** Install by hand.
- **Not byte-for-byte reproducible.** No `SOURCE_DATE_EPOCH` pinning: two builds
  a minute apart differ in archive timestamps. Contents and sizes do not.
