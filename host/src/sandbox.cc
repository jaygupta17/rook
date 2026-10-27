#include "sandbox.h"

#include <fcntl.h>
#include <sched.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

#include "paths.h"

namespace rook {
namespace {

constexpr const char* kOverrideEnv = "ROOK_NO_SANDBOX";
constexpr const char* kProbeEnv = "ROOK_SANDBOX_PROBE";
constexpr const char* kSandboxPathEnv = "CHROME_DEVEL_SANDBOX";
constexpr const char* kHelperName = "chrome-sandbox";

std::string EnvValue(const char* name) {
  const char* value = std::getenv(name);
  return value == nullptr ? std::string() : std::string(value);
}

std::string Lower(std::string s) {
  for (char& c : s) {
    if (c >= 'A' && c <= 'Z') {
      c = static_cast<char>(c - 'A' + 'a');
    }
  }
  return s;
}

// strerror(3) alone loses the name QA greps for ("EPERM"), and the name alone
// loses the explanation, so both.
std::string ErrnoText(int err) {
  const char* name = nullptr;
  switch (err) {
    case EPERM:
      name = "EPERM";
      break;
    case EACCES:
      name = "EACCES";
      break;
    case EINVAL:
      name = "EINVAL";
      break;
    case ENOSYS:
      name = "ENOSYS";
      break;
    case ENOMEM:
      name = "ENOMEM";
      break;
    case ENOENT:
      name = "ENOENT";
      break;
    default:
      break;
  }
  std::string text = std::strerror(err);
  if (name != nullptr) {
    text += std::string(" (") + name + ")";
  } else {
    text += " (errno " + std::to_string(err) + ")";
  }
  return text;
}

std::string Octal(unsigned int mode) {
  char buf[8];
  std::snprintf(buf, sizeof(buf), "%04o", mode & 07777u);
  return std::string(buf);
}

std::string DirName(const std::string& path) {
  const size_t slash = path.find_last_of('/');
  if (slash == std::string::npos) {
    return std::string(".");
  }
  if (slash == 0) {
    return std::string("/");
  }
  return path.substr(0, slash);
}

// Chromium's own search order: $CHROME_DEVEL_SANDBOX, then the helper beside the
// executable, then the CEF payload directory. The package puts libcef.so and the
// helper together in <prefix>/lib/rook/cef, which is not the executable's
// directory, so the third entry is the one a real install uses.
std::string FindHelperPath() {
  const std::string from_env = EnvValue(kSandboxPathEnv);
  if (!from_env.empty()) {
    return from_env;
  }
  const std::string exe = ExecutablePath();
  if (!exe.empty()) {
    const std::string beside_exe = JoinPath(DirName(exe), kHelperName);
    if (FileExists(beside_exe)) {
      return beside_exe;
    }
  }
  return JoinPath(CefRuntimeDir(), kHelperName);
}

struct HelperCheck {
  bool usable = false;
  std::string state;
  std::string why;
};

// What Chromium itself requires before it will use the SUID sandbox: a regular
// file, owned by root, setuid. It aborts the whole browser when the file is
// there but misconfigured, so this has to be exact, not optimistic.
HelperCheck InspectHelper(const std::string& path) {
  HelperCheck out;
  if (path.empty()) {
    out.state = "no candidate path";
    out.why = "no chrome-sandbox helper path is known";
    return out;
  }
  struct stat st {};
  if (::stat(path.c_str(), &st) != 0) {
    const int err = errno;
    out.state = err == ENOENT ? "missing" : "unreadable: " + ErrnoText(err);
    out.why = "no chrome-sandbox helper at " + path;
    if (err != ENOENT) {
      out.why += " (" + ErrnoText(err) + ")";
    }
    return out;
  }

  out.state = "mode " + Octal(static_cast<unsigned>(st.st_mode)) +
              " owner uid " + std::to_string(static_cast<long long>(st.st_uid));
  if (!S_ISREG(st.st_mode)) {
    out.why = path + " is not a regular file";
    return out;
  }
  if (st.st_uid != 0) {
    out.why = path + " is owned by uid " +
              std::to_string(static_cast<long long>(st.st_uid)) +
              ", the sandbox helper must be owned by root";
    return out;
  }
  if ((st.st_mode & S_ISUID) == 0) {
    out.why = path + " is not setuid (needs mode 4755 root:root)";
    return out;
  }
  if ((st.st_mode & 0111) == 0) {
    out.why = path + " is not executable";
    return out;
  }
  out.usable = true;
  return out;
}

// 0 on success, otherwise errno. Chromium's namespace sandbox writes these
// three files, and on Ubuntu 23.10+ it is the write, not the unshare, that an
// AppArmor profile denies first.
int WriteProcFile(const char* path, const std::string& text) {
  const int fd = ::open(path, O_WRONLY);
  if (fd < 0) {
    return errno;
  }
  const ssize_t written = ::write(fd, text.data(), text.size());
  const int err = written == static_cast<ssize_t>(text.size()) ? 0 : errno;
  ::close(fd);
  return err;
}

enum ProbeStage {
  kStageNone = 0,
  kStageUnshareUser,
  kStageSetgroups,
  kStageUidMap,
  kStageGidMap,
  kStageUnsharePidNet,
  kStageFork,
};

struct ProbeResult {
  int stage = kStageNone;
  int err = 0;
};

const char* StageName(int stage) {
  switch (stage) {
    case kStageUnshareUser:
      return "unshare(CLONE_NEWUSER)";
    case kStageSetgroups:
      return "write /proc/self/setgroups";
    case kStageUidMap:
      return "write /proc/self/uid_map";
    case kStageGidMap:
      return "write /proc/self/gid_map";
    case kStageUnsharePidNet:
      return "unshare(CLONE_NEWPID|CLONE_NEWNET)";
    case kStageFork:
      return "fork() inside the new PID namespace";
    default:
      return "nothing";
  }
}

// Runs the first half of Chromium's namespace sandbox in a throwaway child: it
// is the only signal that cannot lie. /proc/sys/user/max_user_namespaces and
// /proc/self/uid_map describe policy, not what this binary is allowed to do
// right now, and container markers (.dockerenv, /run/.containerenv) are absent
// from exactly the restrictive hosts that block namespaces.
ProbeResult ProbeNamespaceSteps() {
  ProbeResult result;
  const std::string uid = std::to_string(static_cast<long long>(::getuid()));
  const std::string gid = std::to_string(static_cast<long long>(::getgid()));

  if (::unshare(CLONE_NEWUSER) != 0) {
    result.stage = kStageUnshareUser;
    result.err = errno;
    return result;
  }
  int err = WriteProcFile("/proc/self/setgroups", "deny");
  if (err != 0 && err != ENOENT) {  // ENOENT: kernels without setgroups control
    result.stage = kStageSetgroups;
    result.err = err;
    return result;
  }
  err = WriteProcFile("/proc/self/uid_map", "0 " + uid + " 1\n");
  if (err != 0) {
    result.stage = kStageUidMap;
    result.err = err;
    return result;
  }
  err = WriteProcFile("/proc/self/gid_map", "0 " + gid + " 1\n");
  if (err != 0) {
    result.stage = kStageGidMap;
    result.err = err;
    return result;
  }
  if (::unshare(CLONE_NEWPID | CLONE_NEWNET) != 0) {
    result.stage = kStageUnsharePidNet;
    result.err = errno;
    return result;
  }
  const pid_t child = ::fork();
  if (child < 0) {
    result.stage = kStageFork;
    result.err = errno;
    return result;
  }
  if (child == 0) {
    ::_exit(0);
  }
  int status = 0;
  while (::waitpid(child, &status, 0) < 0 && errno == EINTR) {
  }
  return result;
}

struct NamespaceProbe {
  bool ok = false;
  std::string detail;
};

NamespaceProbe ProbeUserNamespaces() {
  NamespaceProbe probe;
  int fds[2] = {-1, -1};
  if (::pipe(fds) != 0) {
    probe.detail = "pipe(): " + ErrnoText(errno);
    return probe;
  }

  const pid_t pid = ::fork();
  if (pid < 0) {
    probe.detail = "fork(): " + ErrnoText(errno);
    ::close(fds[0]);
    ::close(fds[1]);
    return probe;
  }
  if (pid == 0) {
    ::close(fds[0]);
    const ProbeResult result = ProbeNamespaceSteps();
    // write(2) only: the child shares stdio buffers it must not flush.
    const ssize_t ignored = ::write(fds[1], &result, sizeof(result));
    (void)ignored;
    ::_exit(0);
  }

  ::close(fds[1]);
  ProbeResult result;
  ssize_t got = 0;
  do {
    got = ::read(fds[0], &result, sizeof(result));
  } while (got < 0 && errno == EINTR);
  ::close(fds[0]);
  int status = 0;
  while (::waitpid(pid, &status, 0) < 0 && errno == EINTR) {
  }

  if (got != static_cast<ssize_t>(sizeof(result))) {
    probe.detail = "the namespace probe child produced no result";
    return probe;
  }
  if (result.stage != kStageNone) {
    probe.detail = std::string(StageName(result.stage)) + ": " +
                   ErrnoText(result.err == 0 ? EPERM : result.err);
    return probe;
  }
  probe.ok = true;
  probe.detail = "available (CLONE_NEWUSER + uid/gid maps + CLONE_NEWPID|CLONE_NEWNET)";
  return probe;
}

}  // namespace

bool SandboxProbeRequested() {
  const std::string value = Lower(Trim(EnvValue(kProbeEnv)));
  return !(value.empty() || value == "0" || value == "false" || value == "no");
}

bool IsBrowserProcess(int argc, char** argv) {
  // Chromium puts --type=<renderer|gpu-process|utility|zygote> on every child's
  // command line; the browser process has no --type switch.
  for (int i = 1; i < argc; ++i) {
    if (StartsWith(std::string(argv[i]), "--type=")) {
      return false;
    }
  }
  return true;
}

SandboxDecision DecideSandbox() {
  SandboxDecision decision;
  decision.override_raw = EnvValue(kOverrideEnv);
  if (!decision.override_raw.empty()) {
    const std::string value = Lower(Trim(decision.override_raw));
    if (value == "1" || value == "true" || value == "yes" || value == "on") {
      decision.forced_off = true;
    } else if (value == "0" || value == "false" || value == "no" ||
               value == "off") {
      decision.forced_on = true;
    } else {
      decision.override_invalid = true;
    }
  }

  decision.helper_path = FindHelperPath();
  const HelperCheck helper = InspectHelper(decision.helper_path);
  decision.helper_state = helper.state;
  decision.helper_why = helper.why;
  decision.helper_usable = helper.usable;

  if (decision.forced_off) {
    decision.outcome = "disabled (ROOK_NO_SANDBOX=1)";
    decision.mechanism = "none";
    decision.reason = "ROOK_NO_SANDBOX=1 asked for an unsandboxed run";
    decision.fix = "unset ROOK_NO_SANDBOX (or set it to 0) to re-enable the sandbox";
    return decision;
  }

  // Chromium refuses to start sandboxed as uid 0 -- it logs
  // "Running as root without --no-sandbox is not supported" and exits -- so a
  // usable helper in front of a root process is still an unusable sandbox.
  if (::geteuid() == 0) {
    decision.outcome = "disabled (running as root)";
    decision.mechanism = "none";
    decision.reason = "running as root (euid 0), and Chromium will not start sandboxed as root";
    decision.fix = "run rook as your normal user";
    return decision;
  }

  if (helper.usable) {
    decision.enabled = true;
    decision.outcome = "enabled via setuid helper";
    decision.mechanism = "setuid helper";
    decision.setuid_helper = true;
    decision.reason = "setuid helper " + decision.helper_path + " (" + helper.state + ")";
    return decision;
  }

  const NamespaceProbe namespaces = ProbeUserNamespaces();
  decision.namespaces_ok = namespaces.ok;
  decision.namespaces_state = namespaces.detail;

  if (namespaces.ok) {
    decision.enabled = true;
    decision.outcome = "enabled via user namespaces";
    decision.mechanism = "user namespaces";
    // A helper that exists but is misconfigured makes Chromium abort before it
    // ever tries the namespace path, so it has to be switched off explicitly.
    decision.disable_setuid_sandbox = true;
    decision.reason = "user namespaces (" + helper.why + ")";
    return decision;
  }

  decision.outcome = "disabled (fallback)";
  decision.mechanism = "none";
  decision.reason = helper.why + ", and user namespaces do not work here: " + namespaces.detail;
  decision.fix =
      "install the rook .deb and run rook from it (the package sets "
      "chrome-sandbox to 4755 root:root), or enable unprivileged user namespaces; "
      "set ROOK_NO_SANDBOX=1 to accept an unsandboxed run";
  return decision;
}

std::string SandboxMessage(const SandboxDecision& decision) {
  if (decision.enabled) {
    return "[rook] sandbox: enabled (" + decision.mechanism + ")";
  }
  if (decision.forced_off) {
    return "[rook] WARNING: Chromium sandbox disabled by ROOK_NO_SANDBOX=1: "
           "renderers run unsandboxed and a hostile page has this user's rights. "
           "Unset ROOK_NO_SANDBOX (or set it to 0) to re-enable the sandbox";
  }
  return "[rook] WARNING: Chromium sandbox disabled: " + decision.reason +
         ". Renderers run unsandboxed and a hostile page has this user's rights. "
         "Fix: " + decision.fix;
}

void ReportSandbox(const SandboxDecision& decision) {
  if (decision.override_invalid) {
    std::fprintf(stderr,
                 "[rook] WARNING: ignoring ROOK_NO_SANDBOX=%s (use 1 to "
                 "disable the sandbox, 0 to require it)\n",
                 decision.override_raw.c_str());
  }
  std::fprintf(stderr, "%s\n", SandboxMessage(decision).c_str());
}

void PrintSandboxProbe(const SandboxDecision& decision) {
  const std::string override_text =
      decision.override_raw.empty()
          ? std::string("unset")
          : "ROOK_NO_SANDBOX=" + decision.override_raw;
  const std::string helper_text =
      decision.helper_usable
          ? std::string("accepted: regular file, owned by root, setuid")
          : "rejected: " + decision.helper_why;

  std::printf("[rook] sandbox: probe (ROOK_SANDBOX_PROBE=1)\n");
  std::printf("[rook] sandbox: override  %s\n", override_text.c_str());
  if (decision.override_invalid) {
    std::printf("[rook] sandbox: override  ignored: expected 1 or 0\n");
  }
  std::printf("[rook] sandbox: helper    %s (%s)\n", decision.helper_path.c_str(),
              decision.helper_state.c_str());
  std::printf("[rook] sandbox: helper    %s\n", helper_text.c_str());
  std::printf("[rook] sandbox: userns    %s\n",
              decision.namespaces_state.empty()
                  ? "not probed (the decision was made before that check)"
                  : decision.namespaces_state.c_str());
  std::printf("[rook] sandbox: decision  %s\n", decision.outcome.c_str());
  std::printf("[rook] sandbox: reason    %s\n", decision.reason.c_str());
  std::printf("[rook] sandbox: fix       %s\n",
              decision.fix.empty() ? "none needed" : decision.fix.c_str());
  if (decision.forced_on && !decision.enabled) {
    std::printf("[rook] sandbox: forced    ROOK_NO_SANDBOX=0: a normal run "
                "refuses to start with this decision (exit 4)\n");
  }
  std::printf("[rook] sandbox: message   %s\n", SandboxMessage(decision).c_str());
  std::fflush(stdout);
}

}  // namespace rook
