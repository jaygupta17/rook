#include "capture.h"

#include <gdk/gdkx.h>
#include <glib.h>

#include <cstdio>
#include <vector>

#include "paths.h"

namespace rook {
namespace {

bool RunImport(const std::vector<std::string>& args, std::string* error) {
  std::vector<char*> argv;
  argv.reserve(args.size() + 2);
  argv.push_back(const_cast<char*>("import"));
  for (const std::string& a : args) {
    argv.push_back(const_cast<char*>(a.c_str()));
  }
  argv.push_back(nullptr);

  gchar* out = nullptr;
  gchar* err = nullptr;
  gint status = 0;
  GError* gerror = nullptr;
  const gboolean spawned =
      g_spawn_sync(nullptr, argv.data(), nullptr, G_SPAWN_SEARCH_PATH, nullptr,
                   nullptr, &out, &err, &status, &gerror);
  std::string stderr_text = err != nullptr ? err : "";
  if (out != nullptr) {
    g_free(out);
  }
  if (err != nullptr) {
    g_free(err);
  }

  bool ok = false;
  if (!spawned) {
    *error = gerror != nullptr ? gerror->message : "could not run import";
    if (gerror != nullptr) {
      g_error_free(gerror);
    }
    return false;
  }
  GError* wait_error = nullptr;
  if (!g_spawn_check_wait_status(status, &wait_error)) {
    *error = wait_error != nullptr ? wait_error->message : "import failed";
    if (wait_error != nullptr) {
      g_error_free(wait_error);
    }
    if (!stderr_text.empty()) {
      *error += ": " + Trim(stderr_text);
    }
    return false;
  }
  ok = true;
  return ok;
}

}  // namespace

bool CaptureWindow(GtkWidget* window,
                   const std::string& path,
                   std::string* detail) {
  if (window == nullptr || !gtk_widget_get_realized(window)) {
    *detail = "window is not realized";
    return false;
  }
  GdkWindow* gdk_window = gtk_widget_get_window(window);
  if (gdk_window == nullptr) {
    *detail = "window has no GdkWindow";
    return false;
  }

  // Flush GTK so the last layout/state changes are on the server before the
  // grab, and let CEF finish any paint it already queued.
  while (gtk_events_pending()) {
    gtk_main_iteration_do(FALSE);
  }
  gdk_display_sync(gtk_widget_get_display(window));

  gchar* dirname = g_path_get_dirname(path.c_str());
  MakeDirs(dirname);
  g_free(dirname);

  const gint width = gdk_window_get_width(gdk_window);
  const gint height = gdk_window_get_height(gdk_window);
  gint origin_x = 0;
  gint origin_y = 0;
  gdk_window_get_origin(gdk_window, &origin_x, &origin_y);

  char xid[32];
  std::snprintf(xid, sizeof(xid), "0x%lx",
                static_cast<unsigned long>(GDK_WINDOW_XID(gdk_window)));

  std::string error;
  const bool grabbed = RunImport({"-window", xid, path}, &error);
  long long bytes = grabbed ? FileSize(path) : -1;

  // `import -window <id>` is the good path: exactly the app window, chrome and
  // page together. Fall back to a root grab cropped to the window rect for X
  // servers/servers that refuse a direct window grab.
  if (!grabbed || bytes < 20000) {
    const std::string crop = std::to_string(width) + "x" + std::to_string(height) +
                             "+" + std::to_string(origin_x) + "+" +
                             std::to_string(origin_y);
    std::string fallback_error;
    if (RunImport({"-window", "root", "-crop", crop, "+repage", path},
                  &fallback_error)) {
      bytes = FileSize(path);
      if (bytes >= 20000) {
        *detail = "root grab cropped to window (" + std::to_string(width) + "x" +
                  std::to_string(height) + ", " + std::to_string(bytes) + " B)";
        return true;
      }
    }
    *detail = "capture failed: " + (error.empty() ? fallback_error : error);
    return false;
  }

  *detail = "window grab xid " + std::string(xid) + " (" + std::to_string(width) +
            "x" + std::to_string(height) + ", " + std::to_string(bytes) + " B)";
  return true;
}

}  // namespace rook
