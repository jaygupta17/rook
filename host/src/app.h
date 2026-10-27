// CEF application object: process entry, settings, and the switch set this
// build needs (software GL, small /dev/shm, the sandbox decision).
#pragma once

#include <string>

#include "include/cef_app.h"

#include "options.h"
#include "sandbox.h"

namespace rook {

void ApplyCefSettings(CefSettings* settings,
                      const Options& options,
                      const SandboxDecision& sandbox);

class EgoApp : public CefApp {
 public:
  EgoApp(const Options& options, const SandboxDecision& sandbox)
      : options_(options), sandbox_(sandbox) {}

  void OnBeforeCommandLineProcessing(
      const CefString& process_type,
      CefRefPtr<CefCommandLine> command_line) override;

 private:
  Options options_;
  SandboxDecision sandbox_;

  IMPLEMENT_REFCOUNTING(EgoApp);
};

}  // namespace rook
