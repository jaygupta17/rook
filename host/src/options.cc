#include "options.h"

#include <unistd.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "paths.h"

namespace rook {
namespace {

std::string TrimTrailingSlashes(std::string s) {
  while (s.size() > 1 && s.back() == '/') {
    s.pop_back();
  }
  return s;
}

bool ParseSize(const std::string& value, int* width, int* height) {
  const size_t x = value.find('x');
  if (x == std::string::npos) {
    return false;
  }
  const int w = std::atoi(value.substr(0, x).c_str());
  const int h = std::atoi(value.substr(x + 1).c_str());
  if (w < 480 || h < 320 || w > 8192 || h > 8192) {
    return false;
  }
  *width = w;
  *height = h;
  return true;
}

bool ParseSpaceSpec(const std::string& value, SpaceSpec* spec, std::string* error) {
  const size_t eq = value.find('=');
  if (eq == std::string::npos) {
    *error = "--space needs NAME=URL[,URL...] (got \"" + value + "\")";
    return false;
  }
  spec->name = Trim(value.substr(0, eq));
  if (spec->name.empty()) {
    *error = "--space needs a name before '=' (got \"" + value + "\")";
    return false;
  }
  std::string urls = value.substr(eq + 1);
  spec->urls.clear();
  size_t pos = 0;
  while (pos <= urls.size()) {
    const size_t comma = urls.find(',', pos);
    const size_t end = comma == std::string::npos ? urls.size() : comma;
    const std::string url = Trim(urls.substr(pos, end - pos));
    if (!url.empty()) {
      spec->urls.push_back(url);
    }
    if (comma == std::string::npos) {
      break;
    }
    pos = comma + 1;
  }
  if (spec->urls.empty()) {
    *error = "--space " + spec->name + " needs at least one URL";
    return false;
  }
  return true;
}

}  // namespace

bool ParseCommandLine(int argc,
                      char** argv,
                      Options* options,
                      std::vector<std::string>* rest,
                      std::string* error) {
  for (int i = 1; i < argc; ++i) {
    const std::string arg(argv[i]);
    auto take_value = [&](std::string* out) -> bool {
      if (i + 1 >= argc) {
        *error = arg + " needs a value";
        return false;
      }
      *out = argv[++i];
      return true;
    };

    if (arg == "--help" || arg == "-h") {
      options->help = true;
      continue;
    }
    if (arg == "--verify-isolation") {
      options->verify_isolation = true;
      continue;
    }
    if (arg == "--no-control-socket") {
      options->control_socket = false;
      continue;
    }
    if (arg == "--socket-path") {
      if (!take_value(&options->socket_path)) {
        return false;
      }
      continue;
    }
    if (arg == "--verbose") {
      options->verbose = true;
      continue;
    }
    if (arg == "--screenshot") {
      std::string value;
      if (!take_value(&value)) {
        return false;
      }
      options->screenshot = value;
      continue;
    }
    if (arg == "--profile") {
      if (!take_value(&options->profile)) {
        return false;
      }
      continue;
    }
    if (arg == "--data-root") {
      if (!take_value(&options->data_root)) {
        return false;
      }
      continue;
    }
    if (arg == "--url") {
      if (!take_value(&options->initial_url)) {
        return false;
      }
      continue;
    }
    if (arg == "--window-size") {
      std::string value;
      if (!take_value(&value)) {
        return false;
      }
      if (!ParseSize(value, &options->width, &options->height)) {
        *error = "--window-size wants WxH, e.g. 1280x820 (got \"" + value + "\")";
        return false;
      }
      continue;
    }
    if (arg == "--space") {
      std::string value;
      if (!take_value(&value)) {
        return false;
      }
      SpaceSpec spec;
      if (!ParseSpaceSpec(value, &spec, error)) {
        return false;
      }
      options->spaces.push_back(std::move(spec));
      continue;
    }
    rest->push_back(arg);
  }

  if (options->profile.empty()) {
    options->profile = "default";
  }

  const std::string data = TrimTrailingSlashes(DataRoot(options->data_root));
  options->profile_id = Slugify(options->profile);
  options->profiles_root = JoinPath(data, "rook/profiles");
  options->profile_dir = JoinPath(options->profiles_root, options->profile_id);
  options->log_file = JoinPath(options->profile_dir, "cef.log");

  if (options->socket_path.empty()) {
    // The socket name is per uid, like the macOS build's, so two app instances
    // for different users cannot collide. XDG_RUNTIME_DIR can point at a
    // directory this process cannot write to (a stale env var from sudo, a
    // container); $TMPDIR/tmp is the documented fallback.
    std::string runtime = RuntimeRoot();
    if (::access(runtime.c_str(), W_OK | X_OK) != 0) {
      std::fprintf(stderr, "[rook] %s is not writable; socket goes to /tmp\n",
                   runtime.c_str());
      runtime = "/tmp";
    }
    options->socket_path =
        JoinPath(runtime, "rook-" + std::to_string(::getuid()) + ".sock");
  }
  return true;
}

void PrintUsage(const char* argv0) {
  std::printf(
      "Rook (Linux) — native shell, M4\n"
      "\n"
      "usage: %s [rook options] [--cef-switch ...]\n"
      "\n"
      "  --space NAME=URL[,URL...]  add a space (tab per URL) to the default\n"
      "                             profile. A space named \"You\" becomes the\n"
      "                             user space; every other space of a profile\n"
      "                             shares that profile's cookies and storage.\n"
      "  --url URL                  page for the default user tab\n"
      "  --profile NAME             id of the default profile (default: default);\n"
      "                             profiles live in <data>/rook/profiles/<id>\n"
      "  --data-root DIR            overrides $XDG_DATA_HOME (used by QA)\n"
      "  --screenshot PATH          load the given spaces, capture the window to\n"
      "                             PATH as PNG, then exit 0\n"
      "  --verify-isolation         after loading, print localStorage/cookie per\n"
      "                             space and profile (proves which storage a\n"
      "                             space really reads)\n"
      "  --window-size WxH          default 1280x820\n"
      "  --socket-path PATH         control socket (default\n"
      "                             $XDG_RUNTIME_DIR/rook-<uid>.sock, fallback\n"
      "                             /tmp when that directory is not writable)\n"
      "  --no-control-socket        do not open the control socket (the shell\n"
      "                             still runs; the bridge has nothing to attach to)\n"
      "  --verbose                  CEF info logging to stderr\n"
      "  --help                     this text\n"
      "\n"
      "The Chromium sandbox is decided at startup (setuid helper, then user\n"
      "namespaces, then a warned fallback):\n"
      "  ROOK_NO_SANDBOX=1      run unsandboxed on purpose (still warns)\n"
      "  ROOK_NO_SANDBOX=0      require the sandbox; exit 4 instead of starting\n"
      "                             unsandboxed\n"
      "  ROOK_SANDBOX_PROBE=1   print the decision and exit 0 (no display needed)\n"
      "\n"
      "The accessibility bridge is turned off when no AT-SPI bus can answer\n"
      "(it would stall the first page on a session with no accessibility\n"
      "service):\n"
      "  ROOK_A11Y_BRIDGE=on|off  force the bridge on or off (default: probe)\n"
      "  NO_AT_BRIDGE=1           the same switch, read by GTK itself\n"
      "\n"
      "The control socket speaks newline-delimited JSON-RPC 2.0 and is opened\n"
      "mode 0600. Data layout:\n"
      "  $XDG_DATA_HOME/rook/profiles/<profile>/   one profile = one context\n"
      "  $XDG_DATA_HOME/rook/profiles.json         profile display names\n"
      "The shell needs an X display; QA runs it on a private Xvfb display.\n",
      argv0);
}

}  // namespace rook
