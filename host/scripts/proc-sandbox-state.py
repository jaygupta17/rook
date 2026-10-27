#!/usr/bin/env python3
"""Report what the Chromium sandbox really did to a browser process tree.

Chromium never sandboxes the browser process itself, only its children, so the
only honest way to check "the sandbox is on" is to look at those children while
they run: a sandboxed child has a seccomp-bpf filter installed (`Seccomp: 2`)
and lives in its own pid/net/user namespaces, while an unsandboxed one (the
fallback this host used to force everywhere) has `Seccomp: 0` and shares every
namespace with the browser.

usage: proc-sandbox-state.py <browser-pid>

Prints one line per descendant:
    <pid> seccomp=<n> nonewprivs=<n> pidns=<same|diff> netns=<same|diff> userns=<same|diff>
and exits 1 when the process tree is empty (nothing to judge).
"""

import os
import sys


def read_status(pid, key):
    try:
        with open("/proc/%d/status" % pid) as handle:
            for line in handle:
                if line.startswith(key + ":"):
                    return line.split()[1]
    except OSError:
        pass
    return "-"


def read_ns(pid, kind):
    try:
        return os.readlink("/proc/%d/ns/%s" % (pid, kind)).strip("[]").split(":")[-1]
    except OSError:
        return None


def children(pid):
    found = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open("/proc/%s/stat" % entry) as handle:
                ppid = int(handle.read().rsplit(")", 1)[1].split()[1])
        except (OSError, IndexError, ValueError):
            continue
        if ppid == pid:
            found.append(int(entry))
    return found


def descendants(pid):
    out = []
    for child in children(pid):
        out.append(child)
        out.extend(descendants(child))
    return out


def main():
    if len(sys.argv) != 2 or not sys.argv[1].isdigit():
        sys.stderr.write("usage: proc-sandbox-state.py <browser-pid>\n")
        return 2
    browser = int(sys.argv[1])
    reference = {kind: read_ns(browser, kind) for kind in ("pid", "net", "user")}
    pids = descendants(browser)
    if not pids:
        sys.stderr.write("no child processes under %d\n" % browser)
        return 1
    for pid in pids:
        cells = ["%d" % pid, "seccomp=" + read_status(pid, "Seccomp"),
                 "nonewprivs=" + read_status(pid, "NoNewPrivs")]
        for kind in ("pid", "net", "user"):
            ours = read_ns(pid, kind)
            shared = ours is not None and ours == reference[kind]
            cells.append("%sns=%s" % (kind, "same" if shared else "diff"))
        print(" ".join(cells))
    return 0


if __name__ == "__main__":
    sys.exit(main())
