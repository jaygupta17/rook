// Is GTK's AT-SPI accessibility bridge usable here?
//
// GTK loads the atk-bridge module during gtk_init(). That module connects to the
// accessibility bus: it uses $AT_SPI_BUS_ADDRESS when it is set, and otherwise
// asks the session bus for org.a11y.Bus. When there is a session bus but no
// accessibility bus behind it (a container, a bare X server, a QA box whose
// per-run a11y bus died, a minimal desktop without at-spi2-core), that lookup
// does not fail fast -- it blocks for tens of seconds, and it blocks Chromium's
// own accessibility start-up with it. The window then appears and stays blank
// because the first navigation never commits: measured on the QA box at 15.7 s
// to nothing (the shell's own 15 s screenshot watchdog is what ends the run),
// against 1.3 s with the bridge off.
//
// So: leave the bridge alone when it can work, and turn it off (NO_AT_BRIDGE=1,
// which GTK checks) when it cannot. An explicit NO_AT_BRIDGE from the caller
// always wins, and ROOK_A11Y_BRIDGE=on|off forces the decision either way (a
// user who needs assistive tech on a box this probe misjudges sets `on`).
#pragma once

#include <string>

namespace rook {

struct A11yDecision {
  // True when this call set NO_AT_BRIDGE=1 for this process.
  bool bridge_disabled = false;
  // Why, in one line for the log ("no AT-SPI bus answered", "left alone: ...").
  std::string reason;
};

// Bounded: never waits more than kProbeTimeoutMs, and does nothing at all when
// the caller already set NO_AT_BRIDGE. Call before gtk_init_check().
A11yDecision DecideAccessibilityBridge();

}  // namespace rook
