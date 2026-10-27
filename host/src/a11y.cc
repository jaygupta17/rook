#include "a11y.h"

#include <glib.h>

namespace rook {
namespace {

// ROOK_A11Y_BRIDGE=on|off forces the decision; empty/auto decides.
constexpr char kOverrideEnv[] = "ROOK_A11Y_BRIDGE";

std::string NonEmpty(const char* name) {
  const char* value = g_getenv(name);
  return value != nullptr ? std::string(value) : std::string();
}

std::string Lower(std::string value) {
  for (char& c : value) {
    if (c >= 'A' && c <= 'Z') {
      c = static_cast<char>(c - 'A' + 'a');
    }
  }
  return value;
}

bool IsOn(const std::string& value) {
  return value == "1" || value == "true" || value == "yes" || value == "on";
}

bool IsOff(const std::string& value) {
  return value == "0" || value == "false" || value == "no" || value == "off";
}

}  // namespace

A11yDecision DecideAccessibilityBridge() {
  A11yDecision decision;

  // The caller (or a desktop launcher) decided already: never override it.
  if (g_getenv("NO_AT_BRIDGE") != nullptr) {
    decision.reason = "left alone: NO_AT_BRIDGE is already set";
    return decision;
  }
  const std::string override_raw = Lower(NonEmpty(kOverrideEnv));
  if (IsOn(override_raw)) {
    decision.reason = "left alone: " + std::string(kOverrideEnv) + "=on";
    return decision;
  }
  // AT_SPI_BUS_ADDRESS is published by at-spi's bus launcher, i.e. by a session
  // that actually runs an accessibility bus. That is the only case where the
  // bridge has somewhere to register; everywhere else atk-bridge starts a bus
  // itself (or waits for one) inside gtk_init, and on this box that call does
  // not return for ~15 s -- the whole first-install stall. So: bridge on only
  // when the session published a bus, off otherwise.
  if (!IsOff(override_raw) && !NonEmpty("AT_SPI_BUS_ADDRESS").empty()) {
    decision.reason = "left alone: AT_SPI_BUS_ADDRESS is set";
    return decision;
  }
  decision.bridge_disabled = true;
  decision.reason = IsOff(override_raw)
                        ? std::string(kOverrideEnv) + "=" + override_raw
                        : "no AT_SPI_BUS_ADDRESS: the session has no "
                          "accessibility bus for the bridge to attach to";
  g_setenv("NO_AT_BRIDGE", "1", TRUE);
  return decision;
}

}  // namespace rook
