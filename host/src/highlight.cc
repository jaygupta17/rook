#include "highlight.h"

#include <cstdio>

namespace rook {
namespace {

constexpr int kSize = 56;
constexpr int kVisibleMs = 1300;
constexpr double kRingRadius = 18.0;
constexpr double kTwoPi = 6.283185307179586;

void PaintRing(cairo_t* cr, double size, double halo_alpha) {
  const double centre = size / 2.0;
  if (halo_alpha > 0.0) {
    cairo_set_line_width(cr, 7.0);
    cairo_set_source_rgba(cr, 1.0, 1.0, 1.0, halo_alpha);
    cairo_arc(cr, centre, centre, kRingRadius, 0.0, kTwoPi);
    cairo_stroke(cr);
  }
  cairo_set_line_width(cr, 3.0);
  cairo_set_source_rgb(cr, 0.32, 0.38, 1.0);
  cairo_arc(cr, centre, centre, kRingRadius, 0.0, kTwoPi);
  cairo_stroke(cr);
}

}  // namespace

MouseHighlight::~MouseHighlight() {
  if (timeout_ != 0) {
    g_source_remove(timeout_);
    timeout_ = 0;
  }
  if (window_ != nullptr) {
    gtk_widget_destroy(window_);
    window_ = nullptr;
  }
}

bool MouseHighlight::EnsureWindow() {
  if (window_ != nullptr) {
    return true;
  }
  window_ = gtk_window_new(GTK_WINDOW_POPUP);
  gtk_window_set_decorated(GTK_WINDOW(window_), FALSE);
  gtk_window_set_resizable(GTK_WINDOW(window_), FALSE);
  gtk_window_set_skip_taskbar_hint(GTK_WINDOW(window_), TRUE);
  gtk_window_set_skip_pager_hint(GTK_WINDOW(window_), TRUE);
  gtk_widget_set_size_request(window_, kSize, kSize);

  area_ = gtk_drawing_area_new();
  gtk_widget_set_size_request(area_, kSize, kSize);
  gtk_widget_set_app_paintable(area_, TRUE);
  g_signal_connect(area_, "draw", G_CALLBACK(OnDraw), this);
  gtk_container_add(GTK_CONTAINER(window_), area_);
  return true;
}

bool MouseHighlight::Show(GtkWidget* over, int x, int y) {
  if (over == nullptr || !gtk_widget_get_realized(over)) {
    return false;
  }
  GtkWidget* toplevel = gtk_widget_get_toplevel(over);
  if (toplevel == nullptr || !GTK_IS_WINDOW(toplevel)) {
    return false;
  }
  if (!EnsureWindow()) {
    return false;
  }

  gint origin_x = 0;
  gint origin_y = 0;
  if (!gtk_widget_translate_coordinates(over, toplevel, 0, 0, &origin_x, &origin_y)) {
    return false;
  }
  gint window_x = 0;
  gint window_y = 0;
  gtk_window_get_position(GTK_WINDOW(toplevel), &window_x, &window_y);
  gtk_window_move(GTK_WINDOW(window_),
                  window_x + origin_x + x - kSize / 2,
                  window_y + origin_y + y - kSize / 2);
  gtk_widget_show_all(window_);

  if (!shaped_) {
    // Punch the ring out of the window: alpha is unavailable without a
    // compositor, so the mask is what makes this look like a pointer rather
    // than a small square.
    GdkWindow* gdk_window = gtk_widget_get_window(window_);
    if (gdk_window != nullptr) {
      cairo_surface_t* mask =
          cairo_image_surface_create(CAIRO_FORMAT_A1, kSize, kSize);
      cairo_t* cr = cairo_create(mask);
      PaintRing(cr, kSize, 1.0);
      cairo_destroy(cr);
      cairo_region_t* region = gdk_cairo_region_create_from_surface(mask);
      gdk_window_shape_combine_region(gdk_window, region, 0, 0);
      gdk_window_input_shape_combine_region(gdk_window, region, 0, 0);
      cairo_region_destroy(region);
      cairo_surface_destroy(mask);
      shaped_ = true;
    }
  }

  if (timeout_ != 0) {
    g_source_remove(timeout_);
  }
  timeout_ = g_timeout_add(kVisibleMs, OnTimeout, this);
  return true;
}

void MouseHighlight::Hide() {
  if (timeout_ != 0) {
    g_source_remove(timeout_);
    timeout_ = 0;
  }
  if (window_ != nullptr) {
    gtk_widget_hide(window_);
  }
}

gboolean MouseHighlight::OnTimeout(gpointer data) {
  auto* self = static_cast<MouseHighlight*>(data);
  self->timeout_ = 0;
  if (self->window_ != nullptr) {
    gtk_widget_hide(self->window_);
  }
  return G_SOURCE_REMOVE;
}

gboolean MouseHighlight::OnDraw(GtkWidget* widget, cairo_t* cr, gpointer data) {
  (void)widget;
  (void)data;
  cairo_set_operator(cr, CAIRO_OPERATOR_CLEAR);
  cairo_paint(cr);
  cairo_set_operator(cr, CAIRO_OPERATOR_OVER);
  PaintRing(cr, kSize, 0.95);
  return FALSE;
}

}  // namespace rook
