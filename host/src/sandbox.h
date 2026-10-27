// Whether this process may start Chromium's sandbox, and why.
//
// The host used to hardcode `no_sandbox` because it was written in a container
// without a setuid helper. That is wrong for a shipped package: Debian/Ubuntu
// installs have a 4755 root:root helper, containers usually have neither that
// nor user namespaces, and Ubuntu 23.10+ can allow user namespaces by sysctl
// while an AppArmor profile denies the actual unshare(2). So the decision is
// made from what this process can observe and do, and it always carries the
// reason with it: a fallback is never silent.
#pragma once

#include <string>

namespace rook {

struct SandboxDecision {
  bool enabled = false;

  // Short label for the probe/QA ("enabled via setuid helper"), always set.
  std::string outcome;

  // ROOK_NO_SANDBOX. forced_off wins over every check; forced_on means the
  // caller refuses to run unsandboxed (main.cc exits instead of starting).
  bool forced_off = false;
  bool forced_on = false;
  bool override_invalid = false;
  std::string override_raw;

  // The chrome-sandbox helper we looked at, and what stat() said about it.
  std::string helper_path;
  std::string helper_state;  // "mode 04755 owner uid 0" / "missing" / ...
  std::string helper_why;    // why it is unusable; empty when usable
  bool helper_usable = false;

  // A real CLONE_NEWUSER/CLONE_NEWPID/CLONE_NEWNET probe in a forked child.
  bool namespaces_ok = false;
  std::string namespaces_state;

  // Enabled through the setuid helper: Chromium must be pointed at it.
  bool setuid_helper = false;
  // Enabled through user namespaces while an unusable helper is around, so
  // Chromium has to be told to skip the setuid path instead of aborting on it.
  bool disable_setuid_sandbox = false;

  std::string mechanism;  // "setuid helper" / "user namespaces" / "none"
  std::string reason;     // one clause, no trailing period
  std::string fix;        // what the user can do; empty when nothing to fix
};

// ROOK_SANDBOX_PROBE=1: print the decision and exit 0, no display needed.
bool SandboxProbeRequested();

// CEF re-executes this binary for renderers, GPU and utility processes, and
// those children carry --type=...; only the browser process owns the decision.
bool IsBrowserProcess(int argc, char** argv);

// Forks a short-lived child, so call it before CEF/GTK start any threads.
SandboxDecision DecideSandbox();

// The one line a normal run prints: "sandbox: enabled (...)" or a WARNING that
// names the reason and the fix. Returned as well so the probe can show exactly
// what a normal run would say.
std::string SandboxMessage(const SandboxDecision& decision);
void ReportSandbox(const SandboxDecision& decision);

// Multi-line, stdout, stable parseable keys ("[rook] sandbox: decision  ...").
void PrintSandboxProbe(const SandboxDecision& decision);

}  // namespace rook
