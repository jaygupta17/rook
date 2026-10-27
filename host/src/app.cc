#include "app.h"

#include <cstdio>
#include <cstdlib>
#include <string>

#include "include/cef_base.h"

#include "paths.h"

namespace rook {
namespace {

// ROOK_GPU=1 keeps the GPU path; software is the reproducible default here.
bool UseSoftwareGl() {
  const char* env = std::getenv("ROOK_GPU");
  return !(env != nullptr && std::string(env) == "1");
}

void AppendExtraFlags(const std::string& flags, CefRefPtr<CefCommandLine> command_line) {
  std::string token;
  for (size_t i = 0; i <= flags.size(); ++i) {
    const char c = i < flags.size() ? flags[i] : ' ';
    if (c != ' ') {
      token.push_back(c);
      continue;
    }
    if (token.empty()) {
      continue;
    }
    std::string name = token;
    token.clear();
    if (StartsWith(name, "--")) {
      name = name.substr(2);
    }
    const size_t eq = name.find('=');
    if (eq == std::string::npos) {
      command_line->AppendSwitch(name);
    } else {
      command_line->AppendSwitchWithValue(name.substr(0, eq), name.substr(eq + 1));
    }
    std::fprintf(stderr, "[rook] extra switch: --%s\n", name.c_str());
  }
}

}  // namespace

void ApplyCefSettings(CefSettings* settings,
                      const Options& options,
                      const SandboxDecision& sandbox) {
  // The sandbox is a runtime decision, never a build-time one: see sandbox.cc.
  // A distro install has the 4755 root:root helper, a container usually has
  // neither that nor user namespaces, and the user can override both ways.
  settings->no_sandbox = !sandbox.enabled;

  if (sandbox.enabled && sandbox.setuid_helper) {
    // Chromium looks for the helper beside the executable; ours ships with the
    // CEF payload (<prefix>/lib/rook/cef, host/cef-runtime) instead.
    ::setenv("CHROME_DEVEL_SANDBOX", sandbox.helper_path.c_str(), 0);
  }

  // CEF re-executes this binary for renderer/GPU/utility processes, so the path
  // has to be absolute: children inherit an unrelated working directory.
  CefString(&settings->browser_subprocess_path) = ExecutablePath();

  settings->windowless_rendering_enabled = false;
  settings->background_color = 0xFFFFFFFF;
  settings->persist_session_cookies = true;

  const std::string runtime = CefRuntimeDir();
  CefString(&settings->resources_dir_path) = runtime;
  CefString(&settings->locales_dir_path) = runtime + "/locales";

  // Every request context must live inside root_cache_path. The profile dir is
  // the root; the user ("You") space is the profile itself, agent spaces are
  // direct children (see Shell::CreateSpace).
  CefString(&settings->root_cache_path) = options.profile_dir;
  CefString(&settings->cache_path) = options.profile_dir;

  CefString(&settings->accept_language_list) = "en-US,en";
  CefString(&settings->log_file) = options.log_file;
  settings->log_severity = options.verbose ? LOGSEVERITY_INFO : LOGSEVERITY_WARNING;
}

void EgoApp::OnBeforeCommandLineProcessing(
    const CefString& process_type,
    CefRefPtr<CefCommandLine> command_line) {
  // Empty process_type means the browser process, which is the only place these
  // switches belong: CEF forwards them to every child process.
  if (!process_type.empty()) {
    return;
  }

  if (!sandbox_.enabled) {
    command_line->AppendSwitch("no-sandbox");
  } else if (sandbox_.disable_setuid_sandbox) {
    // Namespace sandbox: a chrome-sandbox that exists but is not 4755 root:root
    // makes Chromium abort instead of falling through to the namespace path.
    command_line->AppendSwitch("disable-setuid-sandbox");
  }
  // Containers often have a 64 MB /dev/shm, which crashes renderers.
  command_line->AppendSwitch("disable-dev-shm-usage");

  if (UseSoftwareGl()) {
    command_line->AppendSwitch("disable-gpu");
    command_line->AppendSwitch("disable-gpu-compositing");
    command_line->AppendSwitch("disable-software-rasterizer");
  }

  command_line->AppendSwitchWithValue("lang", "en-US");
  // Deterministic chrome metrics for the QA screenshots.
  command_line->AppendSwitchWithValue("force-device-scale-factor", "1");

  if (const char* extra = std::getenv("ROOK_CEF_EXTRA_FLAGS")) {
    AppendExtraFlags(extra, command_line);
  }
}

}  // namespace rook
