// The agent's mouse pointer, drawn over the page.
//
// The CEF page is a native X child window, so a GTK widget inside the shell
// cannot paint above it. This uses a second override-redirect toplevel window
// that follows the pointer position and disappears after a moment. Without a
// compositor there is no alpha, so the ring is punched out of the window with a
// shape mask: only the ring's own pixels exist as far as X is concerned.
#pragma once

#include <gtk/gtk.h>

namespace rook {

class MouseHighlight {
 public:
  MouseHighlight() = default;
  ~MouseHighlight();

  MouseHighlight(const MouseHighlight&) = delete;
  MouseHighlight& operator=(const MouseHighlight&) = delete;

  // `over` is the tab's drawing area; x,y are relative to its top-left corner.
  // Returns false when there is nothing to draw on (no window, no display).
  bool Show(GtkWidget* over, int x, int y);
  void Hide();

 private:
  static gboolean OnDraw(GtkWidget* widget, cairo_t* cr, gpointer data);
  static gboolean OnTimeout(gpointer data);
  bool EnsureWindow();

  GtkWidget* window_ = nullptr;
  GtkWidget* area_ = nullptr;
  guint timeout_ = 0;
  bool shaped_ = false;
};

}  // namespace rook
