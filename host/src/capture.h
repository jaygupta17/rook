// Window capture for the headless QA path.
//
// The window is composited by the X server (no compositor on :99), so an X11
// grab of the toplevel's XID sees the GTK chrome and the CEF child windows
// together. That is the whole point: a CDP screenshot would only show page
// content, not the tab strip and space sidebar.
#pragma once

#include <string>

#include <gtk/gtk.h>

namespace rook {

// Writes a PNG of `window` to `path`. On success `detail` describes what was
// captured (method, size, bytes); on failure it carries the reason.
bool CaptureWindow(GtkWidget* window, const std::string& path, std::string* detail);

}  // namespace rook
