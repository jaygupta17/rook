#include "shell.h"

#include <gdk/gdkx.h>
#include <unistd.h>

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <utility>

#include "browser_client.h"
#include "capture.h"
#include "control.h"
#include "include/cef_app.h"
#include "include/cef_frame.h"
#include "include/wrapper/cef_helpers.h"
#include "json.h"
#include "paths.h"

namespace rook {
namespace {

constexpr int kSidebarWidth = 224;
constexpr int kTabStripHeight = 42;
constexpr int kToolbarHeight = 46;
constexpr int kTabItemHeight = 30;
constexpr const char* kAvatarClasses[] = {"av-0", "av-1", "av-2", "av-3", "av-4"};

Shell* g_shell = nullptr;

// --- stylesheet -------------------------------------------------------------
// GTK3 CSS subset only: no calc(), no transforms, no flexbox.
const char kCss[] = R"CSS(
window {
  background-color: #ffffff;
  font-family: "Lato", "DejaVu Sans", sans-serif;
}
label { font-family: "Lato", "DejaVu Sans", sans-serif; }

button {
  background-image: none;
  background-color: transparent;
  border: none;
  box-shadow: none;
  padding: 0;
  min-width: 0;
  min-height: 0;
  outline-style: none;
  text-shadow: none;
  -gtk-icon-shadow: none;
}

/* sidebar */
.sidebar {
  background-color: #17181d;
  border-right: 1px solid #23252d;
}
.brand { color: #f5f6fa; font-size: 16px; font-weight: 700; }
.branddim { color: #71778a; font-size: 11px; }
.sectionlabel { color: #6d7386; font-size: 10px; font-weight: 700; }
button.spacerow { border-radius: 9px; padding: 0; }
button.spacerow:hover { background-color: #1f212a; }
button.spacerow.active { background-color: #272a34; }
.sname { color: #e9ebf2; font-size: 13px; font-weight: 600; }
.smeta { color: #858b9b; font-size: 11px; }
.avatar { color: #ffffff; font-size: 12px; font-weight: 700; border-radius: 13px; }
.av-0 { background-color: #5b6cff; }
.av-1 { background-color: #e0734a; }
.av-2 { background-color: #2fa27c; }
.av-3 { background-color: #a469ff; }
.av-4 { background-color: #d7a13c; }
button.addspace {
  background-color: #1d1f26;
  color: #c7cddc;
  border: 1px solid #2b2e38;
  border-radius: 9px;
  font-size: 12px;
  font-weight: 600;
}
button.addspace:hover { background-color: #262a34; color: #eef0f6; }

/* tab strip */
.tabstrip {
  background-color: #e6e8ef;
  border-bottom: 1px solid #dcdfe7;
}
button.tab { border-radius: 8px; padding: 0; }
button.tab:hover { background-color: #f4f5fa; }
button.tab.active {
  background-color: #ffffff;
  box-shadow: 0 1px 2px rgba(17, 19, 26, 0.16);
}
.tabtitle { color: #4b5060; font-size: 12px; }
button.tab.active .tabtitle { color: #14161c; }
.tabcloseicon { color: #8d93a2; }
button.tab.active .tabcloseicon { color: #6c7280; }
.spacecloseicon { color: #7f8595; }
button.addtab { color: #5b6171; border-radius: 8px; font-size: 18px; }
button.addtab:hover { background-color: #dfe2ea; color: #14161c; }

/* toolbar */
.toolbar { background-color: #ffffff; border-bottom: 1px solid #e4e7ee; }
button.nav { color: #4b5160; border-radius: 8px; }
button.nav:hover { background-color: #f0f2f7; color: #14161c; }
button.nav:disabled { color: #c6cad4; }
entry.url {
  background-color: #f3f5f9;
  color: #191b22;
  border: 1px solid #e4e8f0;
  border-radius: 9px;
  font-size: 13px;
  min-height: 26px;
}
entry.url:focus { background-color: #ffffff; border-color: #b8c1ff; }

.content { background-color: #ffffff; }

/* handoff banner: the agent paused, the user is driving */
.banner { background-color: #1f2230; border-bottom: 1px solid #2a2d3b; }
.bannertext { color: #e8eaf4; font-size: 12px; font-weight: 600; padding: 7px 14px; }
)CSS";

const char kWelcomeHtml[] = R"HTML(<!doctype html>
<html><head><meta charset="utf-8"><title>New tab</title>
<style>
  html,body{height:100%}
  body{margin:0;display:flex;align-items:center;justify-content:center;background:#fbfbfd;
       color:#15171d;font-family:ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif}
  .card{max-width:560px;padding:0 32px}
  .k{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#8b90a0;font-weight:700}
  h1{font-size:34px;margin:12px 0 12px;letter-spacing:-.02em}
  p{font-size:15px;line-height:1.6;color:#565c6b;margin:0 0 12px}
  code{background:#eef0f6;border-radius:5px;padding:1px 5px;font-size:13px}
</style></head>
<body><div class="card">
  <div class="k">Rook &middot; linux</div>
  <h1>New tab</h1>
  <p>Chromium 156 inside a native GTK3 shell. Type an address above.</p>
  <p>Every space in the sidebar is a separate browser profile &mdash; its own
     cookies, storage and cache under <code>~/.local/share/rook</code>.</p>
</div></body></html>
)HTML";

// --- GTK helpers ------------------------------------------------------------

void AddClass(GtkWidget* widget, const char* name) {
  gtk_style_context_add_class(gtk_widget_get_style_context(widget), name);
}

GtkWidget* NewLabel(const char* text, const char* css_class) {
  GtkWidget* label = gtk_label_new(text);
  gtk_label_set_xalign(GTK_LABEL(label), 0.0f);
  gtk_label_set_yalign(GTK_LABEL(label), 0.5f);
  if (css_class != nullptr) {
    AddClass(label, css_class);
  }
  return label;
}

// Symbolic icon when the theme has it, otherwise a text glyph.
GtkWidget* NewIcon(const char* icon, const char* fallback, int pixel_size) {
  if (gtk_icon_theme_has_icon(gtk_icon_theme_get_default(), icon)) {
    GtkWidget* image = gtk_image_new_from_icon_name(icon, GTK_ICON_SIZE_MENU);
    gtk_image_set_pixel_size(GTK_IMAGE(image), pixel_size);
    gtk_widget_set_valign(image, GTK_ALIGN_CENTER);
    return image;
  }
  GtkWidget* label = gtk_label_new(fallback);
  gtk_widget_set_valign(label, GTK_ALIGN_CENTER);
  return label;
}

GtkWidget* NewIconButton(const char* icon,
                         const char* fallback,
                         const char* css_class,
                         const char* tooltip,
                         int pixel_size = 16) {
  GtkWidget* button = gtk_button_new();
  gtk_container_add(GTK_CONTAINER(button), NewIcon(icon, fallback, pixel_size));
  gtk_button_set_relief(GTK_BUTTON(button), GTK_RELIEF_NONE);
  gtk_widget_set_focus_on_click(button, FALSE);
  if (css_class != nullptr) {
    AddClass(button, css_class);
  }
  if (tooltip != nullptr) {
    gtk_widget_set_tooltip_text(button, tooltip);
  }
  return button;
}

// Widgets reference model objects by id, never by pointer: a tab can be gone by
// the time a queued event is delivered.
struct WidgetId {
  std::string id;
};

void AttachId(GtkWidget* widget, const std::string& id) {
  g_object_set_data_full(
      G_OBJECT(widget), "rook-id", new WidgetId{id},
      [](gpointer data) { delete static_cast<WidgetId*>(data); });
}

const std::string* IdOf(GtkWidget* widget) {
  auto* holder = static_cast<WidgetId*>(g_object_get_data(G_OBJECT(widget), "rook-id"));
  return holder != nullptr ? &holder->id : nullptr;
}

void PumpGtkEvents() {
  int guard = 0;
  while (gtk_events_pending() && ++guard < 500) {
    gtk_main_iteration_do(FALSE);
  }
  GdkDisplay* display = gdk_display_get_default();
  if (display != nullptr) {
    gdk_display_sync(display);
  }
}

std::string UrlForDisplay(const std::string& url) {
  if (url.empty()) {
    return "New tab";
  }
  if (StartsWith(url, "file:")) {
    return "New tab";
  }
  std::string rest = url;
  const size_t scheme = rest.find("://");
  if (scheme != std::string::npos) {
    rest = rest.substr(scheme + 3);
  }
  if (StartsWith(rest, "www.")) {
    rest = rest.substr(4);
  }
  const size_t slash = rest.find('/');
  if (slash != std::string::npos) {
    rest = rest.substr(0, slash);
  }
  return rest.empty() ? "New tab" : rest;
}

std::string NormalizeUrl(const std::string& input) {
  const std::string text = Trim(input);
  if (text.empty()) {
    return text;
  }
  if (text.find("://") != std::string::npos || StartsWith(text, "about:") ||
      StartsWith(text, "data:") || StartsWith(text, "file:") ||
      StartsWith(text, "chrome:")) {
    return text;
  }
  if (StartsWith(text, "localhost") || StartsWith(text, "127.0.0.1") ||
      StartsWith(text, "[::1]")) {
    return "http://" + text;
  }
  // M1 has no search engine: a bare word becomes a host guess.
  return "https://" + text;
}

// Page titles and URLs come from the web: never hand unvalidated bytes to
// Pango (it logs "Invalid UTF-8" and renders garbage).
std::string ValidUtf8(const std::string& text) {
  if (text.empty() || g_utf8_validate(text.c_str(), static_cast<gssize>(text.size()), nullptr)) {
    return text;
  }
  gchar* fixed = g_utf8_make_valid(text.c_str(), static_cast<gssize>(text.size()));
  std::string out = fixed != nullptr ? fixed : std::string();
  g_free(fixed);
  std::fprintf(stderr, "[rook] repaired non-UTF-8 text: %.60s\n", out.c_str());
  return out;
}

// Page titles, URLs and JSON payloads are assembled by hand below; the
// escaping lives in json.h so the control server and the shell share it.

// Minimal extraction for the fixed-shape probe payload.
std::string JsonField(const std::string& json, const char* key) {
  const std::string needle = std::string("\"") + key + "\":";
  size_t pos = json.find(needle);
  if (pos == std::string::npos) {
    return std::string();
  }
  pos += needle.size();
  if (pos >= json.size() || json[pos] != '"') {
    return std::string();
  }
  ++pos;
  std::string out;
  while (pos < json.size() && json[pos] != '"') {
    char c = json[pos++];
    if (c == '\\' && pos < json.size()) {
      const char esc = json[pos++];
      switch (esc) {
        case 'n': out.push_back('\n'); break;
        case 'r': out.push_back('\r'); break;
        case 't': out.push_back('\t'); break;
        default: out.push_back(esc); break;
      }
    } else {
      out.push_back(c);
    }
  }
  return out;
}

void InstallCss() {
  GtkCssProvider* provider = gtk_css_provider_new();
  GError* error = nullptr;
  gtk_css_provider_load_from_data(provider, kCss, -1, &error);
  if (error != nullptr) {
    std::fprintf(stderr, "[rook] stylesheet problem: %s\n", error->message);
    g_error_free(error);
  }
  GdkScreen* screen = gdk_screen_get_default();
  if (screen != nullptr) {
    gtk_style_context_add_provider_for_screen(
        screen, GTK_STYLE_PROVIDER(provider),
        GTK_STYLE_PROVIDER_PRIORITY_APPLICATION);
  }
  g_object_unref(provider);
}



// GtkButton grabs the pointer, so a nested close button never receives its own
// click (verified). Tabs and space rows therefore hit-test the press position:
// the rightmost strip of the widget is the close zone.
struct PressPos {
  double x = 0;
  double y = 0;
  bool valid = false;
};

void AttachPressTracker(GtkWidget* widget) {
  g_object_set_data_full(
      G_OBJECT(widget), "rook-press", new PressPos(),
      [](gpointer data) { delete static_cast<PressPos*>(data); });
}

PressPos* PressOf(GtkWidget* widget) {
  return static_cast<PressPos*>(g_object_get_data(G_OBJECT(widget), "rook-press"));
}

gboolean RecordPress(GtkWidget* widget, GdkEventButton* event, gpointer data) {
  if (event->button != 1) {
    return FALSE;
  }
  if (PressPos* press = PressOf(widget)) {
    press->x = event->x;
    press->y = event->y;
    press->valid = true;
  }
  return FALSE;  // let the button run its own press handling
}

bool PressIsInCloseZone(GtkWidget* widget, double zone_width) {
  PressPos* press = PressOf(widget);
  if (press == nullptr || !press->valid) {
    return false;  // keyboard activation
  }
  const double width = gtk_widget_get_allocated_width(widget);
  const bool in_zone = press->x >= width - zone_width;
  press->valid = false;
  return in_zone;
}

// --- GTK signal handlers ----------------------------------------------------

gboolean OnDeleteEvent(GtkWidget* widget, GdkEvent* event, gpointer data) {
  if (g_shell != nullptr) {
    g_shell->RequestClose();
  }
  return TRUE;  // keep the toplevel until CEF browsers are gone
}

gboolean OnWindowKeyPress(GtkWidget* widget, GdkEventKey* event, gpointer data) {
  if (g_shell == nullptr || (event->state & GDK_CONTROL_MASK) == 0) {
    return FALSE;
  }
  switch (gdk_keyval_to_lower(event->keyval)) {
    case GDK_KEY_t:
      g_shell->UiNewTab();
      return TRUE;
    case GDK_KEY_w:
      g_shell->UiCloseActiveTab();
      return TRUE;
    case GDK_KEY_l:
      g_shell->UiFocusAddressBar();
      return TRUE;
    case GDK_KEY_r:
      g_shell->UiReload();
      return TRUE;
    default:
      return FALSE;
  }
}

void OnTabClicked(GtkButton* button, gpointer data) {
  if (g_shell == nullptr) {
    return;
  }
  const std::string* id = IdOf(GTK_WIDGET(button));
  if (id == nullptr) {
    return;
  }
  Tab* tab = g_shell->FindTab(*id);
  if (tab == nullptr) {
    return;
  }
  if (PressIsInCloseZone(GTK_WIDGET(button), 28)) {
    std::fprintf(stderr, "[rook] close tab %s (x button)\n", id->c_str());
    g_shell->CloseTab(tab);
    return;
  }
  g_shell->ActivateTab(tab);
}

gboolean OnTabHostConfigure(GtkWidget* widget, GdkEventConfigure* event, gpointer data) {
  if (g_shell == nullptr) {
    return FALSE;
  }
  const std::string* id = IdOf(widget);
  if (id == nullptr) {
    return FALSE;
  }
  g_shell->OnTabHostResized(*id, event->width, event->height);
  return FALSE;
}

void OnSpaceRowClicked(GtkButton* button, gpointer data) {
  if (g_shell == nullptr) {
    return;
  }
  const std::string* id = IdOf(GTK_WIDGET(button));
  if (id == nullptr) {
    return;
  }
  Space* space = g_shell->FindSpace(*id);
  if (space == nullptr) {
    return;
  }
  if (!space->is_user && PressIsInCloseZone(GTK_WIDGET(button), 30)) {
    g_shell->CloseSpace(space);
    return;
  }
  g_shell->ActivateSpace(space);
}

void OnAddTabClicked(GtkButton* button, gpointer data) {
  if (g_shell != nullptr) {
    g_shell->UiNewTab();
  }
}

void OnAddSpaceClicked(GtkButton* button, gpointer data) {
  if (g_shell != nullptr) {
    g_shell->UiNewSpace();
  }
}

void OnBackClicked(GtkButton* button, gpointer data) {
  if (g_shell != nullptr) {
    g_shell->UiBack();
  }
}

void OnForwardClicked(GtkButton* button, gpointer data) {
  if (g_shell != nullptr) {
    g_shell->UiForward();
  }
}

void OnReloadClicked(GtkButton* button, gpointer data) {
  if (g_shell != nullptr) {
    g_shell->UiReload();
  }
}

void OnUrlActivate(GtkEntry* entry, gpointer data) {
  if (g_shell != nullptr) {
    g_shell->UiNavigateFromEntry(gtk_entry_get_text(entry));
  }
}

gboolean OnUrlFocusIn(GtkWidget* widget, GdkEventFocus* event, gpointer data) {
  // Hand keyboard focus to the entry while it is being edited, and select the
  // whole address so typing replaces it (omnibox behaviour).
  if (g_shell != nullptr) {
    if (Tab* tab = g_shell->active_tab()) {
      if (tab->browser) {
        tab->browser->GetHost()->SetFocus(false);
      }
    }
  }
  // Selecting here would be undone by the click that follows focus-in, so the
  // selection runs from the idle loop, once the click has been handled.
  g_idle_add_full(
      G_PRIORITY_DEFAULT_IDLE,
      +[](gpointer data) -> gboolean {
        gtk_editable_select_region(GTK_EDITABLE(data), 0, -1);
        return G_SOURCE_REMOVE;
      },
      g_object_ref(widget), g_object_unref);
  return FALSE;
}

// A popup CEF reported (window.open / target=_blank) and we cancelled: the new
// tab is opened from the GLib loop, after OnBeforePopup has unwound. The opener
// is captured now (by id, not pointer) because the page may close it while the
// request waits in the queue.
struct PopupRequest {
  Shell* shell;
  std::string opener_tab_id;
  std::string space_id;
  std::string url;
  std::string window_name;
};

gboolean OpenPopupIdle(gpointer data) {
  auto* request = static_cast<PopupRequest*>(data);
  if (request->shell == g_shell && g_shell != nullptr) {
    Space* space = g_shell->FindSpace(request->space_id);
    if (space == nullptr || space->closing) {
      std::fprintf(stderr, "[rook] popup from %s dropped: space %s is gone\n",
                   request->opener_tab_id.c_str(), request->space_id.c_str());
    } else {
      Tab* opener = g_shell->FindTab(request->opener_tab_id);
      const bool window_here = (space == g_shell->active_space());
      std::fprintf(stderr,
                   "[rook] popup request from %s: space %s, window on %s (%s)\n",
                   request->opener_tab_id.c_str(), space->id.c_str(),
                   g_shell->active_space() ? g_shell->active_space()->id.c_str() : "-",
                   window_here ? "reveal" : "background");
      // Same space as the opener by construction (the request carried its space
      // id), so the tab is adoptable as a normal tab either way. Only the
      // attribution is lost when the opener has closed in the meantime.
      Tab* created = g_shell->OpenTab(space, request->url, true, window_here, opener,
                                      request->window_name);
      std::fprintf(stderr, "[rook] popup %s from %s (name \"%s\")%s\n",
                   created != nullptr ? created->id.c_str() : "(failed)",
                   request->opener_tab_id.c_str(), request->window_name.c_str(),
                   opener == nullptr ? " [opener already closed]" : "");
    }
  }
  delete request;
  return G_SOURCE_REMOVE;
}

}  // namespace

// ===========================================================================
// Shell
// ===========================================================================

class Shell::ControlAdapter : public ControlDelegate {
 public:
  explicit ControlAdapter(Shell* shell) : shell_(shell) {}

  // Every op below ends in the same Shell method the corresponding GTK
  // handler calls: OnTabClicked -> ActivateTab, OnAddTabClicked -> OpenTab,
  // OnSpaceRowClicked -> CloseSpace/ActivateSpace, and so on. Adding behaviour
  // to one path therefore lands in both.
  std::string CreateSpace(const std::string& name) override {
    Space* space = shell_->CreateSpace(name, false);
    return space != nullptr ? space->id : std::string();
  }

  ControlStatus CloseSpace(const std::string& space_id) override {
    Space* space = shell_->FindSpace(space_id);
    if (space == nullptr) {
      return ControlStatus::Fail("no space " + space_id);
    }
    if (space->is_user) {
      return ControlStatus::Fail("the \"You\" space belongs to the user and cannot be closed");
    }
    if (const std::string why = Guard(space); !why.empty()) {
      return ControlStatus::Fail(why);
    }
    shell_->CloseSpace(space);
    return ControlStatus::Ok();
  }

  std::string ListSpaces() const override { return shell_->SpacesJson(); }
  std::string ListTabs(const std::string& space_id) const override {
    return shell_->TabsJson(space_id);
  }

  std::string CreateTab(const std::string& space_id,
                        const std::string& url) override {
    Space* space = shell_->FindSpace(space_id);
    if (space == nullptr) {
      return std::string();
    }
    if (const std::string why = Guard(space); !why.empty()) {
      return std::string();
    }
    // reveal_space = false: a tab in a space the user is not looking at is
    // created and loaded, but the window stays where the user left it.
    Tab* tab = shell_->OpenTab(space, url.empty() ? "about:blank" : url, true, false);
    return tab != nullptr ? tab->id : std::string();
  }

  ControlStatus ActivateSpace(const std::string& space_id) override {
    Space* space = shell_->FindSpace(space_id);
    if (space == nullptr) {
      return ControlStatus::Fail("no space " + space_id);
    }
    if (space->closing) {
      return ControlStatus::Fail("space " + space_id + " is closing");
    }
    // A view operation, not a mutation: no Guard(). The window may be moved to
    // the user's space or to a handed-off space without driving anything.
    shell_->ActivateSpace(space);
    return ControlStatus::Ok();
  }

  ControlStatus ActivateTab(const std::string& space_id,
                            const std::string& tab_id) override {
    Tab* tab = shell_->FindTab(tab_id);
    if (tab == nullptr) {
      return ControlStatus::Fail("no tab " + tab_id);
    }
    if (tab->space == nullptr || tab->space->id != space_id) {
      return ControlStatus::Fail("tab " + tab_id + " is not in space " + space_id);
    }
    if (const std::string why = Guard(tab->space); !why.empty()) {
      return ControlStatus::Fail(why);
    }
    shell_->ActivateTab(tab, tab->space == shell_->active_space());
    return ControlStatus::Ok();
  }

  ControlStatus CloseTab(const std::string& space_id,
                         const std::string& tab_id) override {
    Tab* tab = shell_->FindTab(tab_id);
    if (tab == nullptr) {
      return ControlStatus::Fail("no tab " + tab_id);
    }
    if (tab->space == nullptr || tab->space->id != space_id) {
      return ControlStatus::Fail("tab " + tab_id + " is not in space " + space_id);
    }
    if (const std::string why = Guard(tab->space); !why.empty()) {
      return ControlStatus::Fail(why);
    }
    shell_->CloseTab(tab);
    return ControlStatus::Ok();
  }

  ControlStatus Navigate(const std::string& tab_id, const std::string& url) override {
    Tab* tab = shell_->FindTab(tab_id);
    if (tab == nullptr) {
      return ControlStatus::Fail("no tab " + tab_id);
    }
    if (const std::string why = Guard(tab->space); !why.empty()) {
      return ControlStatus::Fail(why);
    }
    shell_->Navigate(tab, url);
    return ControlStatus::Ok();
  }

  ControlStatus HandOff(const std::string& space_id) override {
    Space* space = shell_->FindSpace(space_id);
    if (space == nullptr) {
      return ControlStatus::Fail("no space " + space_id);
    }
    if (space->is_user) {
      return ControlStatus::Fail("the \"You\" space is always the user's");
    }
    shell_->HandOffSpace(space);
    return ControlStatus::Ok();
  }

  ControlStatus TakeOver(const std::string& space_id) override {
    Space* space = shell_->FindSpace(space_id);
    if (space == nullptr) {
      return ControlStatus::Fail("no space " + space_id);
    }
    if (space->is_user) {
      return ControlStatus::Fail("the \"You\" space is always the user's");
    }
    shell_->TakeOverSpace(space);
    return ControlStatus::Ok();
  }

  ControlStatus SetAgentTaskState(const std::string& space_id,
                                  const std::string& state) override {
    Space* space = shell_->FindSpace(space_id);
    if (space == nullptr) {
      return ControlStatus::Fail("no space " + space_id);
    }
    shell_->SetAgentState(space, state);
    return ControlStatus::Ok();
  }

  ControlStatus HighlightMouseTo(const std::string& space_id, int x, int y) override {
    Space* space = shell_->FindSpace(space_id);
    if (space == nullptr) {
      return ControlStatus::Fail("no space " + space_id);
    }
    if (!shell_->HighlightMouse(space, x, y)) {
      return ControlStatus::Fail("space " + space_id + " has no rendered tab to point at");
    }
    return ControlStatus::Ok();
  }

  ControlStatus SendCdp(const std::string& browser_id,
                        const std::string& message) override {
    Tab* tab = shell_->FindTab(browser_id);
    if (tab == nullptr) {
      return ControlStatus::Fail("no browser " + browser_id);
    }
    if (const std::string why = Guard(tab->space); !why.empty()) {
      return ControlStatus::Fail(why);
    }
    if (!shell_->SendCdpMessage(tab, message)) {
      return ControlStatus::Fail("browser " + browser_id +
                                 " could not take the message (tab closing, or CEF refused it)");
    }
    return ControlStatus::Ok();
  }

  std::string ListState() const override { return shell_->StateJson(); }

  void Quit() override { shell_->RequestClose(); }

 private:
  // The one place the agent-mutation gate lives. The user's own clicks do not
  // come through here, so handing a space off never freezes the window.
  static std::string Guard(const Space* space) {
    if (space == nullptr) {
      return "no space";
    }
    if (space->is_user) {
      return "the \"You\" space belongs to the user; the agent cannot drive it";
    }
    if (space->closing) {
      return "space " + space->id + " is closing";
    }
    if (space->ownership != "agent") {
      return "space " + space->id + " is handed off to the user; the agent cannot drive it";
    }
    return std::string();
  }

  Shell* shell_;
};

Shell::Shell(const Options& options) : options_(options) {}

Shell::~Shell() = default;

bool Shell::Start(std::string* error) {
  g_shell = this;
  data_home_ = DataRoot(options_.data_root);
  app_dir_ = JoinPath(data_home_, "rook");

  if (!MakeDirs(options_.profile_dir)) {
    *error = "cannot create profile directory " + options_.profile_dir;
    return false;
  }
  if (!MakeDirs(JoinPath(app_dir_, "profiles"))) {
    *error = "cannot create " + JoinPath(app_dir_, "profiles");
    return false;
  }

  BuildWindow();

  // CEF creates its child windows with the root visual; a drawing area using a
  // different visual makes X reject the child with BadMatch (silently).
  GdkScreen* screen = gtk_widget_get_screen(window_);
  Display* xdisplay = GDK_DISPLAY_XDISPLAY(gtk_widget_get_display(window_));
  XWindowAttributes root_attributes{};
  XGetWindowAttributes(xdisplay, DefaultRootWindow(xdisplay), &root_attributes);
  root_visual_ = gdk_x11_screen_lookup_visual(
      screen, XVisualIDFromVisual(root_attributes.visual));
  if (root_visual_ == nullptr) {
    std::fprintf(stderr, "[rook] warning: root visual not found; CEF children may fail\n");
  }

  gtk_widget_realize(window_);
  gtk_widget_show_all(window_);
  PumpGtkEvents();

  // Useful for scripts/manual QA: the toplevel XID is what `import -window`
  // wants, and Xvfb has no window manager to look it up any other way.
  if (GdkWindow* window_gdk = gtk_widget_get_window(window_)) {
    std::fprintf(stderr, "[rook] window xid 0x%lx\n",
                 static_cast<unsigned long>(GDK_WINDOW_XID(window_gdk)));
  }


  // User space first, then the agent spaces from the command line.
  const SpaceSpec* user_spec = nullptr;
  for (const SpaceSpec& spec : options_.spaces) {
    if (Slugify(spec.name) == "you") {
      user_spec = &spec;
      break;
    }
  }

  Space* user_space = CreateSpace("You", true);
  if (user_space == nullptr) {
    *error = "could not create the user space";
    return false;
  }
  if (user_spec != nullptr) {
    for (const std::string& url : user_spec->urls) {
      OpenTab(user_space, url, false);
    }
  }
  if (user_space->tabs.empty()) {
    OpenTab(user_space,
            options_.initial_url.empty() ? WelcomeUrl() : options_.initial_url,
            false);
  }

  for (const SpaceSpec& spec : options_.spaces) {
    if (&spec == user_spec) {
      continue;
    }
    Space* space = CreateSpace(spec.name, false);
    if (space == nullptr) {
      continue;
    }
    for (const std::string& url : spec.urls) {
      OpenTab(space, url, false);
    }
    if (space->tabs.empty()) {
      OpenTab(space, WelcomeUrl(), false);
    }
  }

  ActivateSpace(user_space);
  if (!user_space->tabs.empty()) {
    ActivateTab(user_space->tabs.back().get());
  }

  std::fprintf(stderr,
               "[rook] shell up: %zu space(s), profile %s, data %s\n", spaces_.size(),
               options_.profile_dir.c_str(), data_home_.c_str());

  if (!options_.screenshot.empty()) {
    StartScreenshotFlow();
  }
  return true;
}

void Shell::StartControlServer() {
  control_adapter_.reset(new ControlAdapter(this));
  control_ = options_.control_socket ? MakeSocketControlServer() : MakeLocalControlServer();
  if (control_ && !control_->Start(options_.socket_path, control_adapter_.get())) {
    std::fprintf(stderr, "[rook] control transport inactive; the bridge cannot attach\n");
  }
}

void Shell::TearDown() {
  g_shell = nullptr;
  if (open_browsers_ > 0) {
    std::fprintf(stderr, "[rook] warning: %d browser(s) still open at teardown\n",
                 open_browsers_);
  }
  if (cdp_sweep_source_ != 0) {
    g_source_remove(cdp_sweep_source_);
    cdp_sweep_source_ = 0;
  }
  if (event_flush_source_ != 0) {
    g_source_remove(event_flush_source_);
    event_flush_source_ = 0;
  }
  if (shutdown_watchdog_ != 0) {
    g_source_remove(shutdown_watchdog_);
    shutdown_watchdog_ = 0;
  }
  if (control_) {
    // Last chance: events queued by the browsers closing above (tab.closed per
    // tab) go out before the socket disappears.
    FlushEvents();
    control_->Stop();
    control_.reset();
  }
  control_adapter_.reset();
  if (window_ != nullptr) {
    gtk_widget_destroy(window_);
    window_ = nullptr;
    PumpGtkEvents();
  }
}

void Shell::RequestClose() { BeginShutdown(); }

void Shell::Finish(int code) {
  exit_code_ = code;
  BeginShutdown();
}

void Shell::BeginShutdown() {
  if (shutting_down_) {
    return;
  }
  shutting_down_ = true;
  if (shot_source_ != 0) {
    g_source_remove(shot_source_);
    shot_source_ = 0;
  }
  for (auto& space : spaces_) {
    for (auto& tab : space->tabs) {
      if (tab->browser) {
        tab->closing = true;
        tab->browser->GetHost()->CloseBrowser(true);
      }
    }
  }
  if (open_browsers_ == 0) {
    CefQuitMessageLoop();
    return;
  }
  // Defence in depth: if a browser never reports OnBeforeClose the window would
  // hang around forever. The usual cause is a DevTools-created browser (a
  // `Target.createTarget` sent through the CDP broker), which no tab owns; a
  // hung renderer looks the same from here. Five seconds is far more than a
  // normal teardown needs (measured: < 300 ms for six tabs).
  if (shutdown_watchdog_ == 0) {
    shutdown_watchdog_ = g_timeout_add(
        5000,
        +[](gpointer data) -> gboolean {
          auto* self = static_cast<Shell*>(data);
          self->shutdown_watchdog_ = 0;
          std::fprintf(stderr,
                       "[rook] shutdown watchdog: the message loop did not return within "
                       "5 s (open browsers: %d); exiting anyway. A browser created with "
                       "Target.createTarget through the CDP broker is not owned by a tab "
                       "and is the usual cause.\n",
                       self->open_browsers_);
          std::fflush(stderr);
          std::_Exit(self->exit_code_);
        },
        this);
  }
}

// ---------------------------------------------------------------------------
// GTK construction
// ---------------------------------------------------------------------------

void Shell::BuildWindow() {
  InstallCss();
  window_ = gtk_window_new(GTK_WINDOW_TOPLEVEL);
  gtk_window_set_title(GTK_WINDOW(window_), "Rook");
  gtk_window_set_default_size(GTK_WINDOW(window_), options_.width, options_.height);
  g_signal_connect(window_, "delete-event", G_CALLBACK(OnDeleteEvent), nullptr);
  g_signal_connect(window_, "destroy", G_CALLBACK(OnDeleteEvent), nullptr);
  g_signal_connect(window_, "key-press-event", G_CALLBACK(OnWindowKeyPress), nullptr);

  GtkWidget* root = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 0);
  GtkWidget* main = gtk_box_new(GTK_ORIENTATION_VERTICAL, 0);
  gtk_widget_set_hexpand(main, TRUE);

  gtk_box_pack_start(GTK_BOX(root), BuildSidebar(), FALSE, FALSE, 0);
  gtk_box_pack_start(GTK_BOX(main), BuildTabStrip(), FALSE, FALSE, 0);
  gtk_box_pack_start(GTK_BOX(main), BuildToolbar(), FALSE, FALSE, 0);
  gtk_box_pack_start(GTK_BOX(main), BuildBanner(), FALSE, FALSE, 0);
  gtk_box_pack_start(GTK_BOX(main), BuildContent(), TRUE, TRUE, 0);
  gtk_box_pack_start(GTK_BOX(root), main, TRUE, TRUE, 0);
  gtk_container_add(GTK_CONTAINER(window_), root);
}

GtkWidget* Shell::BuildBanner() {
  banner_ = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 0);
  AddClass(banner_, "banner");
  banner_label_ = NewLabel("", "bannertext");
  // The label has to be shown on its own: no_show_all below stops
  // gtk_widget_show_all() from recursing into the banner, so nothing else
  // would ever make the child visible and the bar would collapse to 1 px.
  gtk_widget_show(banner_label_);
  gtk_box_pack_start(GTK_BOX(banner_), banner_label_, FALSE, FALSE, 0);
  // no_show_all keeps gtk_widget_show_all() from revealing it: the banner only
  // exists while a space is handed off.
  gtk_widget_set_no_show_all(banner_, TRUE);
  gtk_widget_set_visible(banner_, FALSE);
  return banner_;
}

GtkWidget* Shell::BuildSidebar() {
  GtkWidget* sidebar = gtk_box_new(GTK_ORIENTATION_VERTICAL, 0);
  AddClass(sidebar, "sidebar");
  gtk_widget_set_size_request(sidebar, kSidebarWidth, -1);
  gtk_widget_set_hexpand(sidebar, FALSE);
  gtk_widget_set_halign(sidebar, GTK_ALIGN_START);

  GtkWidget* head = gtk_box_new(GTK_ORIENTATION_VERTICAL, 1);
  gtk_widget_set_margin_start(head, 16);
  gtk_widget_set_margin_end(head, 16);
  gtk_widget_set_margin_top(head, 18);
  gtk_widget_set_margin_bottom(head, 20);
  GtkWidget* brand = NewLabel("Rook", "brand");
  GtkWidget* tagline = NewLabel("agent browser shell", "branddim");
  gtk_box_pack_start(GTK_BOX(head), brand, FALSE, FALSE, 0);
  gtk_box_pack_start(GTK_BOX(head), tagline, FALSE, FALSE, 0);

  GtkWidget* section = NewLabel("SPACES", "sectionlabel");
  gtk_widget_set_margin_start(section, 18);
  gtk_widget_set_margin_bottom(section, 8);

  space_list_ = gtk_box_new(GTK_ORIENTATION_VERTICAL, 2);
  gtk_widget_set_margin_start(space_list_, 10);
  gtk_widget_set_margin_end(space_list_, 10);

  GtkWidget* add = gtk_button_new_with_label("+   New space");
  AddClass(add, "addspace");
  gtk_widget_set_size_request(add, -1, 34);
  gtk_widget_set_margin_start(add, 10);
  gtk_widget_set_margin_end(add, 10);
  gtk_widget_set_margin_bottom(add, 12);
  gtk_widget_set_margin_top(add, 8);
  g_signal_connect(add, "clicked", G_CALLBACK(OnAddSpaceClicked), nullptr);

  gtk_box_pack_start(GTK_BOX(sidebar), head, FALSE, FALSE, 0);
  gtk_box_pack_start(GTK_BOX(sidebar), section, FALSE, FALSE, 0);
  gtk_box_pack_start(GTK_BOX(sidebar), space_list_, TRUE, TRUE, 0);
  gtk_box_pack_end(GTK_BOX(sidebar), add, FALSE, FALSE, 0);
  return sidebar;
}

GtkWidget* Shell::BuildTabStrip() {
  GtkWidget* strip = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 6);
  AddClass(strip, "tabstrip");
  gtk_widget_set_size_request(strip, -1, kTabStripHeight);

  tab_box_ = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 4);
  gtk_widget_set_valign(tab_box_, GTK_ALIGN_CENTER);

  GtkWidget* scroller = gtk_scrolled_window_new(nullptr, nullptr);
  gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(scroller), GTK_POLICY_AUTOMATIC,
                                 GTK_POLICY_NEVER);
  gtk_scrolled_window_set_overlay_scrolling(GTK_SCROLLED_WINDOW(scroller), TRUE);
  gtk_scrolled_window_set_shadow_type(GTK_SCROLLED_WINDOW(scroller), GTK_SHADOW_NONE);
  gtk_widget_set_hexpand(scroller, TRUE);
  gtk_widget_set_margin_start(scroller, 8);
  gtk_widget_set_margin_top(scroller, 6);
  gtk_widget_set_margin_bottom(scroller, 6);
  gtk_container_add(GTK_CONTAINER(scroller), tab_box_);

  GtkWidget* add = NewIconButton("list-add-symbolic", "+", "addtab", "New tab (Ctrl+T)", 16);
  gtk_widget_set_size_request(add, 28, 28);
  gtk_widget_set_valign(add, GTK_ALIGN_CENTER);
  gtk_widget_set_margin_end(add, 8);
  g_signal_connect(add, "clicked", G_CALLBACK(OnAddTabClicked), nullptr);

  gtk_box_pack_start(GTK_BOX(strip), scroller, TRUE, TRUE, 0);
  gtk_box_pack_end(GTK_BOX(strip), add, FALSE, FALSE, 0);
  return strip;
}

GtkWidget* Shell::BuildToolbar() {
  GtkWidget* bar = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 4);
  AddClass(bar, "toolbar");
  gtk_widget_set_size_request(bar, -1, kToolbarHeight);

  back_button_ = NewIconButton("go-previous-symbolic", "<", "nav", "Back");
  forward_button_ = NewIconButton("go-next-symbolic", ">", "nav", "Forward");
  reload_button_ = NewIconButton("view-refresh-symbolic", "R", "nav", "Reload");

  GtkWidget* buttons[] = {back_button_, forward_button_, reload_button_};
  for (int i = 0; i < 3; ++i) {
    gtk_widget_set_size_request(buttons[i], 30, 30);
    gtk_widget_set_valign(buttons[i], GTK_ALIGN_CENTER);
    gtk_widget_set_margin_top(buttons[i], 8);
    gtk_widget_set_margin_bottom(buttons[i], 8);
    gtk_widget_set_margin_start(buttons[i], i == 0 ? 10 : 0);
    gtk_box_pack_start(GTK_BOX(bar), buttons[i], FALSE, FALSE, 0);
  }
  g_signal_connect(back_button_, "clicked", G_CALLBACK(OnBackClicked), nullptr);
  g_signal_connect(forward_button_, "clicked", G_CALLBACK(OnForwardClicked), nullptr);
  g_signal_connect(reload_button_, "clicked", G_CALLBACK(OnReloadClicked), nullptr);

  url_entry_ = gtk_entry_new();
  AddClass(url_entry_, "url");
  gtk_entry_set_placeholder_text(GTK_ENTRY(url_entry_), "Enter an address");
  gtk_widget_set_hexpand(url_entry_, TRUE);
  gtk_widget_set_valign(url_entry_, GTK_ALIGN_CENTER);
  gtk_widget_set_margin_start(url_entry_, 8);
  gtk_widget_set_margin_end(url_entry_, 14);
  g_signal_connect(url_entry_, "activate", G_CALLBACK(OnUrlActivate), nullptr);
  g_signal_connect(url_entry_, "focus-in-event", G_CALLBACK(OnUrlFocusIn), nullptr);
  gtk_box_pack_start(GTK_BOX(bar), url_entry_, TRUE, TRUE, 0);

  return bar;
}

GtkWidget* Shell::BuildContent() {
  content_ = gtk_stack_new();
  gtk_stack_set_transition_type(GTK_STACK(content_), GTK_STACK_TRANSITION_TYPE_NONE);
  gtk_stack_set_hhomogeneous(GTK_STACK(content_), FALSE);
  gtk_stack_set_vhomogeneous(GTK_STACK(content_), FALSE);
  gtk_widget_set_hexpand(content_, TRUE);
  gtk_widget_set_vexpand(content_, TRUE);
  AddClass(content_, "content");
  return content_;
}

// ---------------------------------------------------------------------------
// Space lifecycle
// ---------------------------------------------------------------------------

Space* Shell::CreateSpace(const std::string& name, bool is_user) {
  OpScope op_scope(this);
  auto space = std::make_unique<Space>();
  space->name = Trim(name).empty() ? "Space" : Trim(name);
  space->is_user = is_user;
  space->id = "sp" + std::to_string(next_space_++);
  space->color = space_rows_++;

  // Directory: the user space *is* the profile dir (the global context), agent
  // spaces are direct children of it, as CEF requires for root_cache_path.
  std::string dir_name = Slugify(space->name);
  auto taken = [this](const std::string& candidate) {
    for (const auto& other : spaces_) {
      if (!other->is_user && other->slug == candidate) {
        return true;
      }
    }
    return false;
  };
  int suffix = 2;
  const std::string base = dir_name;
  while (taken(dir_name)) {
    dir_name = base + "-" + std::to_string(suffix++);
  }
  space->slug = dir_name;
  space->cache_path = is_user ? options_.profile_dir
                              : JoinPath(options_.profile_dir, dir_name);
  if (!MakeDirs(space->cache_path)) {
    std::fprintf(stderr, "[rook] cannot create %s\n", space->cache_path.c_str());
  }

  if (!is_user) {
    CefRequestContextSettings settings;
    CefString(&settings.cache_path) = space->cache_path;
    CefString(&settings.accept_language_list) = "en-US,en";
    space->context = CefRequestContext::CreateContext(settings, nullptr);
    if (!space->context) {
      std::fprintf(stderr, "[rook] request context failed for space %s\n",
                   space->name.c_str());
    }
  }

  Space* raw = space.get();
  spaces_.push_back(std::move(space));
  AddSpaceRow(raw);
  UpdateSpaceRow(raw);
  // UI "new space" and createSpace both land here.
  PushEvent("space.created", "{\"spaceId\":\"" + JsonEscape(raw->id) +
                                 "\",\"name\":\"" + JsonEscape(raw->name) + "\"}");
  return raw;
}

void Shell::AddSpaceRow(Space* space) {
  GtkWidget* row = gtk_button_new();
  AddClass(row, "spacerow");
  gtk_button_set_relief(GTK_BUTTON(row), GTK_RELIEF_NONE);
  gtk_widget_set_focus_on_click(row, FALSE);
  gtk_widget_set_size_request(row, -1, 44);
  AttachId(row, space->id);
  AttachPressTracker(row);
  g_signal_connect(row, "button-press-event", G_CALLBACK(RecordPress), nullptr);
  g_signal_connect(row, "clicked", G_CALLBACK(OnSpaceRowClicked), nullptr);

  GtkWidget* box = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 9);
  gtk_widget_set_margin_start(box, 8);
  gtk_widget_set_margin_end(box, 6);
  gtk_widget_set_margin_top(box, 6);
  gtk_widget_set_margin_bottom(box, 6);
  gtk_widget_set_valign(box, GTK_ALIGN_CENTER);

  char initial[2] = {0, 0};
  initial[0] = static_cast<char>(g_ascii_toupper(space->name[0]));
  GtkWidget* avatar = gtk_label_new(initial);
  gtk_label_set_xalign(GTK_LABEL(avatar), 0.5f);
  gtk_label_set_yalign(GTK_LABEL(avatar), 0.5f);
  gtk_widget_set_size_request(avatar, 26, 26);
  gtk_widget_set_valign(avatar, GTK_ALIGN_CENTER);
  AddClass(avatar, "avatar");
  AddClass(avatar, kAvatarClasses[space->color % 5]);

  // No hexpand anywhere inside the sidebar: gtk_widget_compute_expand() recurses
  // into descendants, and a sidebar that reports expand makes GtkBox share the
  // window width with it (the sidebar then drifts right). The row's text gets its
  // width from the pack flags instead.
  GtkWidget* text = gtk_box_new(GTK_ORIENTATION_VERTICAL, 1);
  gtk_widget_set_halign(text, GTK_ALIGN_FILL);
  gtk_widget_set_valign(text, GTK_ALIGN_CENTER);
  space->name_label = NewLabel(space->name.c_str(), "sname");
  gtk_label_set_ellipsize(GTK_LABEL(space->name_label), PANGO_ELLIPSIZE_END);
  space->meta_label = NewLabel("", "smeta");
  gtk_label_set_ellipsize(GTK_LABEL(space->meta_label), PANGO_ELLIPSIZE_END);
  gtk_box_pack_start(GTK_BOX(text), space->name_label, FALSE, FALSE, 0);
  gtk_box_pack_start(GTK_BOX(text), space->meta_label, FALSE, FALSE, 0);

  gtk_box_pack_start(GTK_BOX(box), avatar, FALSE, FALSE, 0);
  gtk_box_pack_start(GTK_BOX(box), text, TRUE, TRUE, 0);

  if (!space->is_user) {
    GtkWidget* close = NewIcon("window-close-symbolic", "\u00d7", 12);
    AddClass(close, "spacecloseicon");
    gtk_widget_set_tooltip_text(close, "Close space");
    gtk_widget_set_margin_start(close, 4);
    gtk_box_pack_end(GTK_BOX(box), close, FALSE, FALSE, 0);
  }

  gtk_container_add(GTK_CONTAINER(row), box);
  gtk_box_pack_start(GTK_BOX(space_list_), row, FALSE, FALSE, 2);
  space->row = row;
  gtk_widget_show_all(row);
}

void Shell::UpdateSpaceRow(Space* space) {
  if (space == nullptr || space->row == nullptr) {
    return;
  }
  GtkStyleContext* context = gtk_widget_get_style_context(space->row);
  if (space == active_space_) {
    gtk_style_context_add_class(context, "active");
  } else {
    gtk_style_context_remove_class(context, "active");
  }
  if (space->name_label != nullptr) {
    gtk_label_set_text(GTK_LABEL(space->name_label), space->name.c_str());
  }
  if (space->meta_label != nullptr) {
    std::string meta;
    if (space->is_user) {
      meta = "Your profile";
    } else if (space->ownership != "agent") {
      meta = "You have control";
    } else if (!space->agent_state.empty()) {
      meta = space->agent_state;
    } else if (space->tabs.size() == 1) {
      meta = "Agent space - 1 tab";
    } else {
      meta = "Agent space - " + std::to_string(space->tabs.size()) + " tabs";
    }
    gtk_label_set_text(GTK_LABEL(space->meta_label), meta.c_str());
  }
  gtk_widget_queue_draw(space->row);
}

void Shell::DestroySpace(Space* space) {
  OpScope op_scope(this);
  if (space == nullptr) {
    return;
  }
  const bool was_active = (active_space_ == space);
  const std::string space_id = space->id;
  if (space->row != nullptr) {
    gtk_widget_destroy(space->row);
    space->row = nullptr;
  }
  space->context = nullptr;  // release the request context
  std::fprintf(stderr, "[rook] space %s destroyed (request context released)\n",
               space_id.c_str());
  for (auto it = spaces_.begin(); it != spaces_.end(); ++it) {
    if (it->get() == space) {
      spaces_.erase(it);
      break;
    }
  }
  // After the erase: a client that reacts by calling listSpaces/listTabs must
  // already see the space gone.
  PushEvent("space.closed", "{\"spaceId\":\"" + JsonEscape(space_id) + "\"}");
  if (was_active) {
    active_space_ = nullptr;
    if (!spaces_.empty()) {
      ActivateSpace(spaces_.front().get());
    }
  }
  for (auto& other : spaces_) {
    UpdateSpaceRow(other.get());
    for (auto& tab : other->tabs) {
      UpdateTabItem(tab.get());
    }
  }
}

void Shell::CloseSpace(Space* space) {
  OpScope op_scope(this);
  if (space == nullptr || space->is_user || space->closing) {
    return;
  }
  std::vector<std::string> tab_ids;
  tab_ids.reserve(space->tabs.size());
  for (const auto& tab : space->tabs) {
    tab_ids.push_back(tab->id);
  }
  space->closing = true;

  if (active_space_ == space) {
    Space* fallback = nullptr;
    for (const auto& candidate : spaces_) {
      if (candidate.get() != space) {
        fallback = candidate.get();
        break;
      }
    }
    if (fallback != nullptr) {
      ActivateSpace(fallback);
    }
  }

  for (const std::string& id : tab_ids) {
    if (Tab* tab = FindTab(id)) {
      CloseTab(tab);
    }
  }
  if (space->tabs.empty()) {
    DestroySpace(space);
  }
}

void Shell::ActivateSpace(Space* space) {
  OpScope op_scope(this);
  if (space == nullptr || space->closing) {
    return;
  }
  if (active_space_ == space) {
    if (space->active != nullptr) {
      ActivateTab(space->active);
    }
    return;
  }
  active_space_ = space;
  for (auto& candidate : spaces_) {
    UpdateSpaceRow(candidate.get());
  }
  // The strip shows one space at a time. ActivateTab below refreshes it when the
  // space has a tab to activate; an empty space would leave the previous
  // space's tabs on screen, so do it here first.
  for (auto& candidate : spaces_) {
    for (auto& tab : candidate->tabs) {
      UpdateTabItem(tab.get());
    }
  }
  UpdateBanner();
  if (space->active != nullptr) {
    ActivateTab(space->active);
  } else if (!space->tabs.empty()) {
    ActivateTab(space->tabs.back().get());
  }
}

// ---------------------------------------------------------------------------
// Tab lifecycle
// ---------------------------------------------------------------------------

GtkWidget* Shell::CreateTabItem(Tab* tab) {
  GtkWidget* item = gtk_button_new();
  AddClass(item, "tab");
  gtk_button_set_relief(GTK_BUTTON(item), GTK_RELIEF_NONE);
  gtk_widget_set_focus_on_click(item, FALSE);
  gtk_widget_set_size_request(item, 150, kTabItemHeight);
  gtk_widget_set_valign(item, GTK_ALIGN_CENTER);
  AttachId(item, tab->id);
  AttachPressTracker(item);
  g_signal_connect(item, "button-press-event", G_CALLBACK(RecordPress), nullptr);
  g_signal_connect(item, "clicked", G_CALLBACK(OnTabClicked), nullptr);

  GtkWidget* box = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 6);
  gtk_widget_set_margin_start(box, 10);
  gtk_widget_set_margin_end(box, 5);
  gtk_widget_set_valign(box, GTK_ALIGN_CENTER);

  tab->title_label = NewLabel(tab->title.c_str(), "tabtitle");
  gtk_label_set_ellipsize(GTK_LABEL(tab->title_label), PANGO_ELLIPSIZE_END);
  gtk_label_set_max_width_chars(GTK_LABEL(tab->title_label), 20);
  // Same trap as the sidebar: hexpand here makes the whole tab report expand and
  // GtkBox then spreads the tabs across the strip. The pack flags below already
  // give the label the spare width inside the tab.
  gtk_widget_set_hexpand(tab->title_label, FALSE);

  GtkWidget* close = NewIcon("window-close-symbolic", "\u00d7", 12);
  AddClass(close, "tabcloseicon");
  gtk_widget_set_tooltip_text(close, "Close tab");

  gtk_box_pack_start(GTK_BOX(box), tab->title_label, TRUE, TRUE, 0);
  gtk_box_pack_end(GTK_BOX(box), close, FALSE, FALSE, 0);
  gtk_container_add(GTK_CONTAINER(item), box);
  gtk_widget_show_all(item);
  return item;
}

Tab* Shell::OpenTab(Space* space,
                    const std::string& url,
                    bool activate,
                    bool reveal_space,
                    Tab* opener,
                    const std::string& window_name) {
  OpScope op_scope(this);
  if (space == nullptr || space->closing) {
    return nullptr;
  }
  Tab* previous = space->active;
  Space* shown_space = active_space_;
  Tab* shown_tab = active_tab();

  auto tab = std::make_unique<Tab>();
  tab->id = "tb" + std::to_string(next_tab_++);
  tab->space = space;
  tab->url = url;
  tab->title = UrlForDisplay(url);
  // Attribution travels with the tab from here on: OnAfterCreated looks the tab
  // up by id, so the opener is already on it when CEF hands us the browser.
  if (!window_name.empty()) {
    tab->window_name = window_name;
  }
  // Only a live tab of the same space can be an opener: anything else would be
  // an attribution the window cannot check, so it is left empty instead.
  if (opener != nullptr && opener->space == space) {
    tab->opener_id = opener->id;
  }

  tab->host = gtk_drawing_area_new();
  gtk_widget_set_hexpand(tab->host, TRUE);
  gtk_widget_set_vexpand(tab->host, TRUE);
  gtk_widget_set_size_request(tab->host, 120, 120);
  if (root_visual_ != nullptr) {
    gtk_widget_set_visual(tab->host, root_visual_);
  }
  AttachId(tab->host, tab->id);
  g_signal_connect(tab->host, "configure-event", G_CALLBACK(OnTabHostConfigure),
                   nullptr);
  gtk_container_add(GTK_CONTAINER(content_), tab->host);

  tab->item = CreateTabItem(tab.get());
  gtk_box_pack_start(GTK_BOX(tab_box_), tab->item, FALSE, FALSE, 0);
  gtk_widget_show(tab->item);

  space->tabs.push_back(std::move(tab));
  Tab* created = space->tabs.back().get();
  UpdateSpaceRow(space);
  // Before activation: a bridge that sees tab.activated for a tab it has not
  // been told about yet cannot place it.
  PushTabCreated(created);

  // CEF needs the host mapped to hand us an XID, so the new tab is shown first.
  // Everything a caller might have been looking at is restored below.
  ActivateTab(created);
  CreateBrowserForTab(created);

  if (!activate && previous != nullptr && previous != created) {
    if (space == active_space_) {
      ActivateTab(previous);
    } else {
      space->active = previous;  // background tab in a background space
    }
  }
  if (!reveal_space && shown_space != nullptr && shown_space != space) {
    ActivateSpace(shown_space);
    if (shown_tab != nullptr && FindTab(shown_tab->id) == shown_tab) {
      ActivateTab(shown_tab);
    }
  }
  UpdateSpaceRow(space);
  return created;
}

void Shell::CreateBrowserForTab(Tab* tab) {
  if (tab == nullptr || tab->browser != nullptr) {
    return;
  }
  GdkWindow* gdk_window = gtk_widget_get_window(tab->host);
  if (gdk_window == nullptr) {
    std::fprintf(stderr, "[rook] tab %s has no X window; browser not created\n",
                 tab->id.c_str());
    tab->loaded = true;
    tab->failed = true;
    return;
  }
  GtkAllocation allocation;
  gtk_widget_get_allocation(tab->host, &allocation);
  int width = allocation.width;
  int height = allocation.height;
  if (width < 64 || height < 64) {
    width = std::max(640, options_.width - kSidebarWidth);
    height = std::max(400, options_.height - kTabStripHeight - kToolbarHeight);
  }

  CefWindowInfo window_info;
  window_info.SetAsChild(GDK_WINDOW_XID(gdk_window), CefRect(0, 0, width, height));
  // Chrome runtime style ignores parent_window and creates its own toplevel;
  // embedding in an existing X11 window requires Alloy.
  window_info.runtime_style = CEF_RUNTIME_STYLE_ALLOY;

  CefBrowserSettings browser_settings;
  browser_settings.background_color = 0xFFFFFFFF;

  CefRefPtr<CefClient> client(new BrowserClient(this, tab->id));
  const bool ok = CefBrowserHost::CreateBrowser(
      window_info, client, tab->url, browser_settings, nullptr, tab->space->context);
  if (!ok) {
    std::fprintf(stderr, "[rook] CreateBrowser failed for tab %s\n", tab->id.c_str());
    tab->loaded = true;
    tab->failed = true;
  } else {
    std::fprintf(stderr, "[rook] tab %s -> %s\n", tab->id.c_str(), tab->url.c_str());
  }
}

void Shell::ActivateTab(Tab* tab, bool reveal_space) {
  OpScope op_scope(this);
  if (tab == nullptr || tab->space == nullptr) {
    return;
  }
  Space* space = tab->space;
  if (space->closing) {
    return;
  }
  if (reveal_space && active_space_ != space) {
    ActivateSpace(space);
  }
  const bool changed = (space->active != tab);
  space->active = tab;
  std::fprintf(stderr, "[rook] active tab %s (%s)%s\n", tab->id.c_str(),
               tab->title.c_str(), space == active_space_ ? "" : " [background]");
  if (changed) {
    // Emitted even for a background space: the bridge tracks which tab each
    // space considers current, not just the one on screen.
    PushTabActivated(tab);
  }
  if (shutting_down_) {
    // Teardown closes browsers one by one; re-entering GTK layout (and pumping
    // events) while a sibling widget is being destroyed is asking for trouble.
    return;
  }
  if (space != active_space_) {
    // An agent switched tabs in a space the user is not looking at. The tab
    // strip of that space is not on screen; keep its state honest and leave the
    // window (and the user's tab) exactly where they were.
    for (auto& candidate : space->tabs) {
      UpdateTabItem(candidate.get());
    }
    return;
  }
  if (content_ != nullptr && tab->host != nullptr) {
    gtk_stack_set_visible_child(GTK_STACK(content_), tab->host);
    gtk_widget_show(tab->host);
  }
  PumpGtkEvents();

  for (auto& space_iter : spaces_) {
    for (auto& candidate : space_iter->tabs) {
      UpdateTabItem(candidate.get());
    }
  }
  UpdateVisibility();

  if (tab->browser) {
    CefRefPtr<CefBrowserHost> host = tab->browser->GetHost();
    host->WasResized();
    host->Invalidate(PET_VIEW);
    host->SetFocus(true);
  }
  if (url_entry_ != nullptr) {
    gtk_entry_set_text(GTK_ENTRY(url_entry_), tab->url.c_str());
  }
  UpdateToolbar();
  UpdateWindowTitle();
}

void Shell::UpdateTabItem(Tab* tab) {
  if (tab == nullptr || tab->item == nullptr) {
    return;
  }
  const bool active = (tab->space == active_space_ && tab->space->active == tab);
  GtkStyleContext* context = gtk_widget_get_style_context(tab->item);
  if (active) {
    gtk_style_context_add_class(context, "active");
  } else {
    gtk_style_context_remove_class(context, "active");
  }
  if (tab->title_label != nullptr) {
    gtk_label_set_text(GTK_LABEL(tab->title_label), tab->title.c_str());
  }
  // The strip shows one space at a time; switching spaces swaps it.
  gtk_widget_set_visible(tab->item, tab->space == active_space_);
  gtk_widget_set_tooltip_text(tab->item,
                              tab->title.empty() ? tab->url.c_str() : tab->title.c_str());
  gtk_widget_queue_draw(tab->item);
}

void Shell::UpdateVisibility() {
  for (auto& space : spaces_) {
    for (auto& tab : space->tabs) {
      const bool ui_visible =
          (space.get() == active_space_ && tab.get() == active_space_->active);
      if (tab->ui_visible == ui_visible) {
        continue;
      }
      tab->ui_visible = ui_visible;
      ApplyVisibility(tab.get());
    }
  }
}

// A tab is rendered when the user is looking at it or an agent round has it
// awake. `hidden_applied` keeps the CEF calls edge-triggered: WasHidden(true)
// on every layout pass would throw away the compositor's tiles for nothing.
void Shell::ApplyVisibility(Tab* tab) {
  if (tab == nullptr || !tab->browser) {
    return;
  }
  const bool visible = tab->ui_visible || tab->cdp_awake;
  const bool hidden = !visible;
  if (tab->hidden_applied == hidden) {
    return;
  }
  tab->browser->GetHost()->WasHidden(hidden);
  tab->hidden_applied = hidden;
  std::fprintf(stderr, "[rook] tab %s %s\n", tab->id.c_str(), hidden ? "parked" : "awake");
}

void Shell::UpdateToolbar() {
  Tab* tab = active_tab();
  if (back_button_ != nullptr) {
    gtk_widget_set_sensitive(back_button_, tab != nullptr && tab->can_back);
  }
  if (forward_button_ != nullptr) {
    gtk_widget_set_sensitive(forward_button_, tab != nullptr && tab->can_forward);
  }
  if (reload_button_ != nullptr) {
    gtk_widget_set_sensitive(reload_button_, tab != nullptr);
  }
}

void Shell::UpdateWindowTitle() {
  if (window_ == nullptr) {
    return;
  }
  std::string title = "Rook";
  Tab* tab = active_tab();
  if (tab != nullptr && !tab->title.empty()) {
    title = tab->title + " - Rook";
  }
  gtk_window_set_title(GTK_WINDOW(window_), title.c_str());
}

void Shell::CloseTab(Tab* tab) {
  OpScope op_scope(this);
  if (tab == nullptr || tab->closing) {
    return;
  }
  tab->closing = true;
  if (tab->browser) {
    tab->browser->GetHost()->CloseBrowser(true);
  } else {
    DestroyTab(tab);
  }
}

void Shell::DestroyTab(Tab* tab) {
  OpScope op_scope(this);
  if (tab == nullptr || tab->space == nullptr) {
    return;
  }
  Space* space = tab->space;
  GtkWidget* item = tab->item;
  GtkWidget* host = tab->host;
  const bool was_active = (space->active == tab);
  const std::string tab_id = tab->id;  // `tab` dies in the erase below

  for (auto it = space->tabs.begin(); it != space->tabs.end(); ++it) {
    if (it->get() == tab) {
      space->tabs.erase(it);
      break;
    }
  }
  // Before the widgets go and before any fallback tab appears: the tab is gone
  // from the model at this point, so the push is already true.
  PushTabClosed(space, tab_id);
  if (was_active) {
    space->active = nullptr;
  }
  if (item != nullptr) {
    gtk_widget_destroy(item);
  }
  if (host != nullptr) {
    gtk_widget_destroy(host);
  }
  if (space->active == nullptr && !space->tabs.empty()) {
    space->active = space->tabs.back().get();
  }
  UpdateSpaceRow(space);

  if (space == active_space_) {
    if (space->active != nullptr) {
      ActivateTab(space->active);
    } else if (!shutting_down_ && !space->closing) {
      // Last tab in a live space: keep the window usable instead of blank.
      OpenTab(space, WelcomeUrl(), true);
    }
  }
  for (auto& other : spaces_) {
    for (auto& candidate : other->tabs) {
      UpdateTabItem(candidate.get());
    }
  }
  UpdateToolbar();
  UpdateWindowTitle();

  if (space->closing && space->tabs.empty()) {
    DestroySpace(space);
  }
}

// ---------------------------------------------------------------------------
// CEF callbacks
// ---------------------------------------------------------------------------

void Shell::OnBrowserCreated(const std::string& tab_id, CefRefPtr<CefBrowser> browser) {
  ++open_browsers_;
  Tab* tab = FindTab(tab_id);
  if (tab == nullptr) {
    return;  // tab closed while the browser was being created
  }
  tab->browser = browser;
  std::fprintf(stderr, "[rook] tab %s browser ready (xid 0x%lx)\n", tab_id.c_str(),
               static_cast<unsigned long>(browser->GetHost()->GetWindowHandle()));
  ApplyVisibility(tab);  // a tab created in a hidden space starts parked

  // A bridge sends Page.enable the instant createTab returns, which is before
  // CEF gets here. Those messages waited in the tab; hand them over in order.
  if (!tab->pending_cdp.empty()) {
    std::fprintf(stderr, "[rook] tab %s flushing %zu queued CDP message(s)\n",
                 tab_id.c_str(), tab->pending_cdp.size());
    CefRefPtr<CefBrowserHost> host = browser->GetHost();
    CdpKeepAwake(tab);
    for (const std::string& message : tab->pending_cdp) {
      if (!host->SendDevToolsMessage(message.data(), message.size()) && control_) {
        control_->PushCdpError(tab_id, -32002,
                               "CEF rejected a queued DevTools message (malformed JSON?)");
      }
    }
    tab->pending_cdp.clear();
  }
}

void Shell::OnBrowserClosed(const std::string& tab_id) {
  if (open_browsers_ > 0) {
    --open_browsers_;
  }
  Tab* tab = FindTab(tab_id);
  if (tab != nullptr) {
    tab->browser = nullptr;
    DestroyTab(tab);
  }
  if (shutting_down_ && open_browsers_ == 0) {
    CefQuitMessageLoop();
  }
}

void Shell::OnTabHostResized(const std::string& tab_id, int width, int height) {
  Tab* tab = FindTab(tab_id);
  if (tab == nullptr || !tab->browser || width <= 0 || height <= 0) {
    return;
  }
  CefRefPtr<CefBrowserHost> host = tab->browser->GetHost();
  const CefWindowHandle handle = host->GetWindowHandle();
  if (handle != 0) {
    // CEF watches Configure events on its own window, not on our parent, so the
    // resize has to be forwarded by hand.
    GdkDisplay* display = gdk_display_get_default();
    if (display != nullptr) {
      XResizeWindow(GDK_DISPLAY_XDISPLAY(display), handle,
                    static_cast<unsigned int>(width),
                    static_cast<unsigned int>(height));
    }
  }
  host->WasResized();
}

void Shell::OnLoadEnd(const std::string& tab_id,
                      const std::string& url,
                      int http_status) {
  Tab* tab = FindTab(tab_id);
  if (tab == nullptr) {
    return;
  }
  const std::string previous_url = tab->url;
  const std::string previous_title = tab->title;
  tab->loaded = true;
  tab->failed = false;
  if (!url.empty()) {
    tab->url = url;
  }
  if (tab->title.empty() || tab->title == UrlForDisplay(url)) {
    tab->title = UrlForDisplay(url);
  }
  std::fprintf(stderr, "[rook] tab %s loaded (http %d) %s\n", tab_id.c_str(),
               http_status, url.c_str());
  UpdateTabItem(tab);
  PushTabUpdated(tab, tab->url != previous_url, tab->title != previous_title);
  if (tab == active_tab()) {
    if (url_entry_ != nullptr && !gtk_widget_has_focus(url_entry_)) {
      gtk_entry_set_text(GTK_ENTRY(url_entry_), tab->url.c_str());
    }
    UpdateWindowTitle();
  }
}

void Shell::OnLoadError(const std::string& tab_id,
                        int error_code,
                        const std::string& error_text,
                        const std::string& failed_url) {
  Tab* tab = FindTab(tab_id);
  if (tab == nullptr) {
    return;
  }
  tab->loaded = true;
  tab->failed = true;
  if (tab->title.empty()) {
    tab->title = "Couldn't load";
  }
  std::fprintf(stderr, "[rook] tab %s load error %d (%s) %s\n", tab_id.c_str(),
               error_code, error_text.c_str(), failed_url.c_str());
  UpdateTabItem(tab);
  UpdateWindowTitle();
}

void Shell::OnNavState(const std::string& tab_id,
                       bool loading,
                       bool can_back,
                       bool can_forward) {
  Tab* tab = FindTab(tab_id);
  if (tab == nullptr) {
    return;
  }
  tab->can_back = can_back;
  tab->can_forward = can_forward;
  if (tab == active_tab()) {
    UpdateToolbar();
  }
}

void Shell::OnTitleChange(const std::string& tab_id, const std::string& title) {
  Tab* tab = FindTab(tab_id);
  if (tab == nullptr || title.empty()) {
    return;
  }
  const std::string clean = ValidUtf8(title);
  if (tab->title == clean) {
    return;  // [event] tab.updated is edge-triggered, not per callback
  }
  tab->title = clean;
  UpdateTabItem(tab);
  if (tab == active_tab()) {
    UpdateWindowTitle();
  }
  PushTabUpdated(tab, false, true);
}

void Shell::OnAddressChange(const std::string& tab_id, const std::string& url) {
  Tab* tab = FindTab(tab_id);
  if (tab == nullptr) {
    return;
  }
  const std::string clean = ValidUtf8(url);
  if (tab->url == clean) {
    return;
  }
  tab->url = clean;
  if (tab == active_tab() && url_entry_ != nullptr &&
      !gtk_widget_has_focus(url_entry_)) {
    gtk_entry_set_text(GTK_ENTRY(url_entry_), tab->url.c_str());
  }
  PushTabUpdated(tab, true, false);
}

void Shell::OnOpenPopup(const std::string& opener_tab_id,
                        const std::string& url,
                        const std::string& window_name) {
  // OnBeforePopup runs deep inside CEF's window-open path; open the tab from the
  // GLib loop, after that call unwinds.
  Tab* opener = FindTab(opener_tab_id);
  if (opener == nullptr || opener->space == nullptr || opener->space->closing) {
    // The source browser is not one of our live tabs. Nothing to attribute the
    // popup to and no space to own it, so it is dropped rather than invented.
    std::fprintf(stderr, "[rook] popup %s from unknown tab %s dropped\n",
                 url.c_str(), opener_tab_id.c_str());
    return;
  }
  auto* request = new PopupRequest{this, opener_tab_id, opener->space->id,
                                   url.empty() ? "about:blank" : url, window_name};
  g_idle_add(OpenPopupIdle, request);
}

void Shell::OnDevToolsMessage(const std::string& tab_id, const std::string& message) {
  // Verbatim: id, sessionId and payload are the bridge's business, not ours.
  if (control_) {
    control_->PushCdpEvent(tab_id, message);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle pushes
//
// One emitter per model change, called from the model method itself rather than
// from the RPC dispatch, so a GTK click and a control request emit identically.
// The bridge rebuilds CDP target state from these (see README).
// ---------------------------------------------------------------------------

void Shell::PushEvent(const std::string& method, const std::string& params_json) {
  if (!control_) {
    return;
  }
  // Always logged: the host log is how a failed popup/handoff is diagnosed, and
  // tab.updated is edge-triggered (see PushTabUpdated), so this stays small.
  std::fprintf(stderr, "[event] %s %s\n", method.c_str(), params_json.c_str());
  pending_events_.push_back(PendingEvent{method, params_json});
  // An event emitted outside any model action (a CEF title/URL callback) has no
  // OpScope to flush it, so there is always an idle behind it. Inside an
  // operation the idle just leaves the queue alone (see below).
  if (event_flush_source_ == 0) {
    event_flush_source_ = g_idle_add(
        +[](gpointer data) -> gboolean {
          auto* shell = static_cast<Shell*>(data);
          shell->event_flush_source_ = 0;
          if (shell->op_depth_ == 0) {
            shell->FlushEvents();
          }
          // depth > 0: the operation that is running flushes on its way out.
          return G_SOURCE_REMOVE;
        },
        this);
  }
}

void Shell::FlushEvents() {
  if (event_flush_source_ != 0) {
    g_source_remove(event_flush_source_);
    event_flush_source_ = 0;
  }
  if (pending_events_.empty()) {
    return;
  }
  std::vector<PendingEvent> batch;
  batch.swap(pending_events_);
  for (const PendingEvent& event : batch) {
    if (control_ != nullptr) {
      control_->PushEvent(event.method, event.params);
    }
  }
}

void Shell::PushTabCreated(Tab* tab) {
  if (tab == nullptr || tab->space == nullptr) {
    return;
  }
  std::string params = "{\"spaceId\":\"" + JsonEscape(tab->space->id) + "\"";
  params += ",\"tabId\":\"" + JsonEscape(tab->id) + "\"";
  params += ",\"url\":\"" + JsonEscape(tab->url) + "\"";
  if (!tab->opener_id.empty()) {
    params += ",\"openerTabId\":\"" + JsonEscape(tab->opener_id) + "\"";
  }
  if (!tab->window_name.empty()) {
    params += ",\"windowName\":\"" + JsonEscape(tab->window_name) + "\"";
  }
  params += "}";
  PushEvent("tab.created", params);
}

void Shell::PushTabUpdated(Tab* tab, bool url_changed, bool title_changed) {
  if (tab == nullptr || tab->space == nullptr || (!url_changed && !title_changed)) {
    return;
  }
  std::string params = "{\"spaceId\":\"" + JsonEscape(tab->space->id) + "\"";
  params += ",\"tabId\":\"" + JsonEscape(tab->id) + "\"";
  if (url_changed) {
    params += ",\"url\":\"" + JsonEscape(tab->url) + "\"";
  }
  if (title_changed) {
    params += ",\"title\":\"" + JsonEscape(tab->title) + "\"";
  }
  params += "}";
  PushEvent("tab.updated", params);
}

void Shell::PushTabActivated(Tab* tab) {
  if (tab == nullptr || tab->space == nullptr) {
    return;
  }
  PushEvent("tab.activated", "{\"spaceId\":\"" + JsonEscape(tab->space->id) +
                                 "\",\"tabId\":\"" + JsonEscape(tab->id) + "\"}");
}

void Shell::PushTabClosed(const Space* space, const std::string& tab_id) {
  if (space == nullptr) {
    return;
  }
  PushEvent("tab.closed", "{\"spaceId\":\"" + JsonEscape(space->id) +
                              "\",\"tabId\":\"" + JsonEscape(tab_id) + "\"}");
}

// ---------------------------------------------------------------------------
// Model lookups and actions
// ---------------------------------------------------------------------------

Tab* Shell::FindTab(const std::string& tab_id) const {
  for (const auto& space : spaces_) {
    for (const auto& tab : space->tabs) {
      if (tab->id == tab_id) {
        return tab.get();
      }
    }
  }
  return nullptr;
}

Space* Shell::FindSpace(const std::string& space_id) const {
  for (const auto& space : spaces_) {
    if (space->id == space_id) {
      return space.get();
    }
  }
  return nullptr;
}

void Shell::Navigate(Tab* tab, const std::string& input) {
  OpScope op_scope(this);
  if (tab == nullptr) {
    return;
  }
  const std::string url = NormalizeUrl(input);
  if (url.empty()) {
    return;
  }
  const bool url_changed = (tab->url != url);
  tab->url = url;
  tab->loaded = false;
  tab->failed = false;
  if (tab->browser) {
    tab->browser->GetMainFrame()->LoadURL(url);
  } else {
    CreateBrowserForTab(tab);
  }
  if (tab == active_tab() && url_entry_ != nullptr) {
    gtk_entry_set_text(GTK_ENTRY(url_entry_), url.c_str());
    if (tab->browser) {
      tab->browser->GetHost()->SetFocus(true);
    }
  }
  UpdateTabItem(tab);
  UpdateWindowTitle();
  // Emitted here as well as from OnAddressChange: the model already holds the
  // new URL, so the callback's dedupe would otherwise swallow the change.
  PushTabUpdated(tab, url_changed, false);
}

std::string Shell::WelcomeUrl() {
  const std::string dir = JoinPath(app_dir_, "shell");
  MakeDirs(dir);
  const std::string path = JoinPath(dir, "new-tab.html");
  if (!FileExists(path)) {
    FILE* file = std::fopen(path.c_str(), "wb");
    if (file != nullptr) {
      std::fwrite(kWelcomeHtml, 1, sizeof(kWelcomeHtml) - 1, file);
      std::fclose(file);
    }
  }
  return "file://" + path;
}

namespace {

std::string TabJson(const Tab* tab, const Tab* active) {
  std::string json = "{\"tabId\":\"" + JsonEscape(tab->id) + "\"";
  json += ",\"browserId\":\"" + JsonEscape(tab->id) + "\"";
  json += ",\"title\":\"" + JsonEscape(tab->title) + "\"";
  json += ",\"url\":\"" + JsonEscape(tab->url) + "\"";
  json += ",\"active\":" + std::string(tab == active ? "true" : "false");
  json += ",\"loading\":" +
          std::string(tab->loaded || tab->failed ? "false" : "true");
  json += ",\"closing\":" + std::string(tab->closing ? "true" : "false");
  // Always present (empty when not applicable) so a bridge can read them
  // without a truthiness dance; tab.created omits them when empty.
  json += ",\"openerTabId\":\"" + JsonEscape(tab->opener_id) + "\"";
  json += ",\"windowName\":\"" + JsonEscape(tab->window_name) + "\"";
  json += "}";
  return json;
}

std::string SpaceJson(const Space* space, const Space* active_space, bool with_tabs) {
  std::string json = "{\"spaceId\":\"" + JsonEscape(space->id) + "\"";
  json += ",\"name\":\"" + JsonEscape(space->name) + "\"";
  json += ",\"user\":" + std::string(space->is_user ? "true" : "false");
  json += ",\"active\":" + std::string(space == active_space ? "true" : "false");
  json += ",\"ownership\":\"" + JsonEscape(space->ownership) + "\"";
  json += ",\"agentState\":\"" + JsonEscape(space->agent_state) + "\"";
  json += ",\"cache\":\"" + JsonEscape(space->cache_path) + "\"";
  json += ",\"tabCount\":" + std::to_string(space->tabs.size());
  json += ",\"activeTabId\":\"" + JsonEscape(space->active != nullptr ? space->active->id
                                                                    : "") + "\"";
  if (with_tabs) {
    json += ",\"tabs\":[";
    bool first = true;
    for (const auto& tab : space->tabs) {
      if (!first) {
        json += ",";
      }
      first = false;
      json += TabJson(tab.get(), space->active);
    }
    json += "]";
  }
  json += "}";
  return json;
}

std::string TabsArray(const Space* space) {
  std::string json = "[";
  bool first = true;
  for (const auto& tab : space->tabs) {
    if (!first) {
      json += ",";
    }
    first = false;
    json += TabJson(tab.get(), space->active);
  }
  json += "]";
  return json;
}

}  // namespace

std::string Shell::SpacesJson() const {
  std::string json = "{\"activeSpaceId\":\"";
  json += JsonEscape(active_space_ != nullptr ? active_space_->id : "");
  json += "\",\"spaces\":[";
  bool first = true;
  for (const auto& space : spaces_) {
    if (!first) {
      json += ",";
    }
    first = false;
    json += SpaceJson(space.get(), active_space_, false);
  }
  json += "]}";
  return json;
}

std::string Shell::TabsJson(const std::string& space_id) const {
  const Space* space = FindSpace(space_id);
  if (space == nullptr) {
    return std::string();
  }
  std::string json = "{\"spaceId\":\"" + JsonEscape(space->id) + "\"";
  json += ",\"name\":\"" + JsonEscape(space->name) + "\"";
  json += ",\"ownership\":\"" + JsonEscape(space->ownership) + "\"";
  json += ",\"activeTabId\":\"" +
          JsonEscape(space->active != nullptr ? space->active->id : "") + "\"";
  json += ",\"tabs\":" + TabsArray(space) + "}";
  return json;
}

std::string Shell::StateJson() const {
  std::string json = "{\"activeSpaceId\":\"";
  json += JsonEscape(active_space_ != nullptr ? active_space_->id : "");
  json += "\",\"spaces\":[";
  bool first = true;
  for (const auto& space : spaces_) {
    if (!first) {
      json += ",";
    }
    first = false;
    json += SpaceJson(space.get(), active_space_, true);
  }
  json += "]}";
  return json;
}

// ---------------------------------------------------------------------------
// UI intents
// ---------------------------------------------------------------------------

void Shell::UiNewTab() {
  Space* space = active_space_;
  if (space == nullptr) {
    return;
  }
  OpenTab(space, WelcomeUrl(), true);
  if (url_entry_ != nullptr) {
    gtk_widget_grab_focus(url_entry_);
  }
}

void Shell::UiNewSpace() {
  Space* space = CreateSpace("Space " + std::to_string(next_space_), false);
  if (space == nullptr) {
    return;
  }
  OpenTab(space, WelcomeUrl(), true);
  ActivateSpace(space);
  if (space->active != nullptr) {
    ActivateTab(space->active);
  }
}

void Shell::UiCloseActiveTab() {
  if (Tab* tab = active_tab()) {
    CloseTab(tab);
  }
}

void Shell::UiBack() {
  Tab* tab = active_tab();
  if (tab != nullptr && tab->browser) {
    tab->browser->GoBack();
  }
}

void Shell::UiForward() {
  Tab* tab = active_tab();
  if (tab != nullptr && tab->browser) {
    tab->browser->GoForward();
  }
}

void Shell::UiReload() {
  Tab* tab = active_tab();
  if (tab != nullptr && tab->browser) {
    tab->browser->Reload();
  }
}

void Shell::UiNavigateFromEntry(const std::string& text) {
  Tab* tab = active_tab();
  if (tab == nullptr) {
    if (active_space_ != nullptr) {
      tab = OpenTab(active_space_, NormalizeUrl(text), true);
    }
    return;
  }
  Navigate(tab, text);
}

void Shell::UiFocusAddressBar() {
  if (url_entry_ == nullptr) {
    return;
  }
  gtk_widget_grab_focus(url_entry_);
  gtk_editable_select_region(GTK_EDITABLE(url_entry_), 0, -1);
}

// ---------------------------------------------------------------------------
// Control channel: CDP broker and agent state
// ---------------------------------------------------------------------------

bool Shell::SendCdpMessage(Tab* tab, const std::string& message) {
  if (tab == nullptr || message.empty() || tab->closing) {
    return false;
  }
  if (!tab->browser) {
    // CEF creates browsers asynchronously. Hold the message instead of failing:
    // a bridge sends Page.enable the moment createTab returns.
    constexpr size_t kMaxPendingCdp = 1024;
    if (tab->pending_cdp.size() >= kMaxPendingCdp) {
      std::fprintf(stderr, "[rook] tab %s CDP queue full\n", tab->id.c_str());
      return false;
    }
    tab->pending_cdp.push_back(message);
    std::fprintf(stderr, "[rook] tab %s CDP queued (%zu bytes, browser not ready)\n",
                 tab->id.c_str(), message.size());
    return true;
  }
  CdpKeepAwake(tab);
  const bool sent =
      tab->browser->GetHost()->SendDevToolsMessage(message.data(), message.size());
  if (!sent) {
    std::fprintf(stderr, "[rook] tab %s refused a %zu byte CDP message\n",
                 tab->id.c_str(), message.size());
  }
  return sent;
}

// Parked tabs have WasHidden(true): timers are throttled and the compositor can
// stop producing frames. An agent round needs a live page, so the first message
// of a round wakes it; CdpSweepTick re-parks it once it has been quiet for a
// while and the user is not looking at it.
void Shell::CdpKeepAwake(Tab* tab) {
  if (tab == nullptr) {
    return;
  }
  tab->last_cdp_us = g_get_monotonic_time();
  if (tab->cdp_awake) {
    return;
  }
  tab->cdp_awake = true;
  ApplyVisibility(tab);
  if (tab->browser) {
    tab->browser->GetHost()->WasResized();  // ask for a frame now, not on the next tick
  }
  StartCdpSweep();
}

void Shell::StartCdpSweep() {
  if (cdp_sweep_source_ != 0) {
    return;
  }
  cdp_sweep_source_ = g_timeout_add(
      1000,
      +[](gpointer data) -> gboolean {
        return static_cast<Shell*>(data)->CdpSweepTick() ? G_SOURCE_CONTINUE
                                                         : G_SOURCE_REMOVE;
      },
      this);
}

bool Shell::CdpSweepTick() {
  constexpr int64_t kQuietUs = 10 * 1000 * 1000;
  const int64_t now = g_get_monotonic_time();
  bool awake = false;
  for (auto& space : spaces_) {
    for (auto& tab : space->tabs) {
      if (!tab->cdp_awake) {
        continue;
      }
      if (tab->ui_visible || now - tab->last_cdp_us < kQuietUs) {
        awake = true;
        continue;
      }
      tab->cdp_awake = false;
      ApplyVisibility(tab.get());
    }
  }
  if (!awake) {
    cdp_sweep_source_ = 0;
  }
  return awake;
}

void Shell::HandOffSpace(Space* space) {
  if (space == nullptr) {
    return;
  }
  space->ownership = "user";
  std::fprintf(stderr, "[rook] space %s handed off to the user\n", space->id.c_str());
  UpdateSpaceRow(space);
  UpdateBanner();
  PushEvent("control.changed", "{\"spaceId\":\"" + JsonEscape(space->id) +
                                   "\",\"state\":\"user\"}");
}

void Shell::TakeOverSpace(Space* space) {
  if (space == nullptr) {
    return;
  }
  space->ownership = "agent";
  std::fprintf(stderr, "[rook] space %s taken over by the agent\n", space->id.c_str());
  UpdateSpaceRow(space);
  UpdateBanner();
  PushEvent("control.changed", "{\"spaceId\":\"" + JsonEscape(space->id) +
                                   "\",\"state\":\"agent\"}");
}

void Shell::SetAgentState(Space* space, const std::string& state) {
  if (space == nullptr) {
    return;
  }
  space->agent_state = ValidUtf8(state);
  std::fprintf(stderr, "[rook] space %s state \"%s\"\n", space->id.c_str(),
               space->agent_state.c_str());
  UpdateSpaceRow(space);
  UpdateBanner();
}

bool Shell::HighlightMouse(Space* space, int x, int y) {
  if (space == nullptr || space->active == nullptr) {
    return false;
  }
  if (space != active_space_) {
    // The ring lives above the page the user can see. Pointing into a space
    // that is not on screen would paint over unrelated content.
    return false;
  }
  return highlight_.Show(space->active->host, x, y);
}

void Shell::UpdateBanner() {
  if (banner_ == nullptr || banner_label_ == nullptr) {
    return;
  }
  const Space* space = active_space_;
  std::string text;
  if (space != nullptr && !space->is_user && space->ownership != "agent") {
    text = "Agent paused - you have control of \"" + space->name + "\"";
    if (!space->agent_state.empty()) {
      text += "  |  " + space->agent_state;
    }
  }
  gtk_label_set_text(GTK_LABEL(banner_label_), text.c_str());
  gtk_widget_set_visible(banner_, !text.empty());
}

// ---------------------------------------------------------------------------
// Headless screenshot run
// ---------------------------------------------------------------------------

void Shell::StartScreenshotFlow() {
  std::fprintf(stderr, "[rook] screenshot mode: %s\n", options_.screenshot.c_str());
  shot_start_us_ = g_get_monotonic_time();
  shot_phase_ = ShotPhase::kWaitLoads;
  shot_source_ = g_timeout_add(
      50,
      +[](gpointer data) -> gboolean {
        return static_cast<Shell*>(data)->ScreenshotTick() ? G_SOURCE_CONTINUE
                                                           : G_SOURCE_REMOVE;
      },
      this);
}

bool Shell::ScreenshotTick() {
  const int64_t now = g_get_monotonic_time();
  const int64_t elapsed = now - shot_start_us_;
  switch (shot_phase_) {
    case ShotPhase::kWaitLoads: {
      size_t loaded = 0;
      size_t total = 0;
      for (const auto& space : spaces_) {
        for (const auto& tab : space->tabs) {
          ++total;
          if (tab->loaded) {
            ++loaded;
          }
        }
      }
      if (total > 0 && loaded == total) {
        std::fprintf(stderr, "[rook] all %zu tab(s) loaded in %.1f s\n", total,
                     static_cast<double>(elapsed) / 1e6);
        shot_phase_ = ShotPhase::kSettle;
        settle_until_us_ = now + 900 * 1000;
        return true;
      }
      if (elapsed > 15 * 1000 * 1000) {
        std::fprintf(stderr,
                     "[rook] timeout waiting for loads (%zu/%zu); capturing anyway\n",
                     loaded, total);
        shot_phase_ = ShotPhase::kSettle;
        settle_until_us_ = now + 400 * 1000;
      }
      return true;
    }
    case ShotPhase::kSettle:
      if (now < settle_until_us_) {
        return true;
      }
      shot_phase_ = ShotPhase::kCapture;
      return true;
    case ShotPhase::kCapture:
      shot_phase_ = ShotPhase::kIdle;
      CaptureAndFinish();
      return false;
    case ShotPhase::kIdle:
    default:
      return false;
  }
}

void Shell::OnConsoleMessage(const std::string& tab_id,
                             const std::string& message) {
  // fixtures/isolation.html reports what the page itself can see. If two spaces
  // disagree, their request contexts are not sharing storage.
  const std::string prefix = "EGO_STORAGE ";
  if (!StartsWith(message, prefix)) {
    return;
  }
  Tab* tab = FindTab(tab_id);
  if (tab == nullptr || tab->space == nullptr) {
    return;
  }
  storage_reports_[tab->space->id] = message.substr(prefix.size());
}

void Shell::PrintIsolationReport() {
  for (const auto& space : spaces_) {
    const auto found = storage_reports_.find(space->id);
    if (found == storage_reports_.end()) {
      std::fprintf(stderr, "[isolation] space=\"%s\" error=\"no storage report\"\n",
                   space->name.c_str());
      continue;
    }
    const std::string error = JsonField(found->second, "error");
    if (!error.empty()) {
      std::fprintf(stderr, "[isolation] space=\"%s\" error=\"%s\"\n",
                   space->name.c_str(), error.c_str());
      continue;
    }
    std::fprintf(stderr,
                 "[isolation] space=\"%s\" localStorage=\"%s\" cookie=\"%s\"\n",
                 space->name.c_str(), JsonField(found->second, "ls").c_str(),
                 JsonField(found->second, "ck").c_str());
  }
}

void Shell::CaptureAndFinish() {
  if (options_.verify_isolation) {
    PrintIsolationReport();
  }
  std::string detail;
  const bool ok = CaptureWindow(window_, options_.screenshot, &detail);
  if (ok) {
    std::fprintf(stderr, "[rook] screenshot wrote %s (%s)\n",
                 options_.screenshot.c_str(), detail.c_str());
  } else {
    std::fprintf(stderr, "[rook] screenshot FAILED: %s\n", detail.c_str());
  }
  Finish(ok ? 0 : 4);
}

}  // namespace rook
