// rook — native Linux shell for the Rook agent browser.
//
// Process layout mirrors the CEF sample apps: this binary is both the browser
// process and the sub-process entry point (CEF re-executes it for renderer, GPU
// and utility processes). GTK is initialised first so CEF picks up the same
// GLib main context and its message loop can pump GTK events.
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#include <gtk/gtk.h>

#include "include/cef_app.h"
#include "include/cef_version.h"

#include "a11y.h"
#include "app.h"
#include "options.h"
#include "paths.h"
#include "sandbox.h"
#include "shell.h"

int main(int argc, char* argv[]) {
  rook::Options options;
  std::vector<std::string> remaining;
  std::string error;
  if (!rook::ParseCommandLine(argc, argv, &options, &remaining, &error)) {
    std::fprintf(stderr, "rook: %s\n\n", error.c_str());
    rook::PrintUsage(argv[0]);
    return 2;
  }
  if (options.help) {
    rook::PrintUsage(argv[0]);
    return 0;
  }

  // Is Chromium's sandbox usable here? The answer feeds both CefSettings and the
  // browser command line, and the user-namespace probe forks, which is only safe
  // while this process is still single-threaded: do it before GTK and CEF start
  // (and before gtk_init_check, so ROOK_SANDBOX_PROBE works without a
  // display).
  rook::SandboxDecision sandbox;
  if (rook::IsBrowserProcess(argc, argv)) {
    sandbox = rook::DecideSandbox();
    if (rook::SandboxProbeRequested()) {
      rook::PrintSandboxProbe(sandbox);
      return 0;
    }
    if (sandbox.forced_on && !sandbox.enabled) {
      std::fprintf(stderr,
                   "[rook] ERROR: ROOK_NO_SANDBOX=0 asks for the Chromium "
                   "sandbox, but it cannot start here: %s.\n"
                   "[rook] Refusing to run unsandboxed. Fix: %s, or unset "
                   "ROOK_NO_SANDBOX (the default: warn and fall back).\n",
                   sandbox.reason.c_str(), sandbox.fix.c_str());
      return 4;
    }
    rook::ReportSandbox(sandbox);
  }

  // CEF initialises GTK itself and wants the locale locked before that;
  // gtk_disable_setlocale() also keeps the Gtk-WARNING out of the log.
  gtk_disable_setlocale();
  g_set_prgname("rook");
  g_set_application_name("Rook");
  // Before gtk_init_check(): GTK loads atk-bridge here, and a session bus with
  // no accessibility bus behind it does not fail fast -- it blocks the first
  // navigation (blank window, tens of seconds). Bounded probe, one line of log.
  // Browser process only: a child must do nothing but CefExecuteProcess below.
  if (rook::IsBrowserProcess(argc, argv)) {
    const rook::A11yDecision a11y = rook::DecideAccessibilityBridge();
    if (a11y.bridge_disabled) {
      std::fprintf(stderr, "[rook] accessibility bridge off: %s\n",
                   a11y.reason.c_str());
    }
  }
  if (!gtk_init_check(nullptr, nullptr)) {
    std::fprintf(stderr,
                 "[rook] no usable display (DISPLAY=%s). The shell needs X11; "
                 "QA runs it on a private Xvfb display.\n",
                 g_getenv("DISPLAY") != nullptr ? g_getenv("DISPLAY") : "(unset)");
    return 1;
  }

  // CefMainArgs wants argv[0] plus the switches. GTK never sees these, so CEF
  // switches from the command line survive untouched.
  std::vector<std::string> cef_args;
  cef_args.reserve(remaining.size() + 1);
  cef_args.emplace_back(argv[0]);
  for (const std::string& arg : remaining) {
    cef_args.push_back(arg);
  }
  std::vector<char*> cef_argv;
  cef_argv.reserve(cef_args.size());
  for (std::string& arg : cef_args) {
    cef_argv.push_back(const_cast<char*>(arg.c_str()));
  }
  const int cef_argc = static_cast<int>(cef_argv.size());
  CefMainArgs main_args(cef_argc, cef_argv.data());

  CefRefPtr<rook::EgoApp> app(new rook::EgoApp(options, sandbox));

  const int subprocess_exit = CefExecuteProcess(main_args, app.get(), nullptr);
  if (subprocess_exit >= 0) {
    // Leave with _Exit(), never `return subprocess_exit`: on Linux the zygote
    // *forks* renderers instead of re-executing this binary, so a child's call
    // stack still runs through main(). Chromium rotates the stack guard in
    // those forked children (--change-stack-guard-on-fork, on by default), so
    // main()'s saved canary -- written before the fork -- no longer matches the
    // thread's, and the epilogue aborts the child with "*** stack smashing
    // detected ***" although nothing overflowed (measured in the same process:
    // canary at load 0x0557..1c00 vs 0x5aa8..5e00 at the check; disabling the
    // rotation removes it). A forked child must not run the embedder's epilogue
    // at all; CEF's contract for a non-negative result is only "exit with this
    // value", and a child's diagnostics are unbuffered stderr plus CEF's own
    // log file, so skipping atexit/stdio teardown loses nothing.
    std::_Exit(subprocess_exit);
  }

  CefSettings settings;
  rook::ApplyCefSettings(&settings, options, sandbox);
  if (!CefInitialize(main_args, settings, app.get(), nullptr)) {
    std::fprintf(stderr, "[rook] CefInitialize failed (log: %s)\n",
                 options.log_file.c_str());
    return 1;
  }

  std::fprintf(stderr,
               "[rook] rook %s (CEF %s), profiles in %s\n", "0.4.0-M4",
               CEF_VERSION, options.profiles_root.c_str());

  int exit_code = 1;
  {
    rook::Shell shell(options);
    if (!shell.Start(&error)) {
      std::fprintf(stderr, "[rook] shell failed to start: %s\n", error.c_str());
      CefShutdown();
      return 1;
    }
    shell.StartControlServer();
    CefRunMessageLoop();
    exit_code = shell.exit_code();
    std::fprintf(stderr, "[rook] message loop returned (exit %d), tearing down\n", exit_code);
    shell.TearDown();
  }
  CefShutdown();
  std::fprintf(stderr, "[rook] CefShutdown finished\n");
  return exit_code;
}
