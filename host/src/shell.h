// The native shell: one GTK3 window with a space sidebar, a tab strip, a
// toolbar, and one CEF browser per tab parented into a GtkStack page.
//
// Threading: CEF runs in single-threaded ("external message pump" disabled)
// mode on the same thread as GTK, so every CEF callback here is on the UI
// thread and may touch widgets directly. The control socket is serviced from
// the same GLib loop, which is why RPC requests need no locking either.
#pragma once

#include <map>
#include <memory>
#include <string>
#include <vector>

#include <gtk/gtk.h>

#include "include/cef_browser.h"
#include "include/cef_request_context.h"

#include "control.h"
#include "highlight.h"
#include "options.h"

namespace rook {

class Shell;

struct Space;

struct Tab {
  std::string id;
  Space* space = nullptr;
  std::string url;
  std::string title;
  bool loaded = false;   // main frame reached OnLoadEnd (or failed)
  bool failed = false;
  bool closing = false;
  bool can_back = false;
  bool can_forward = false;

  // Popup attribution. Both come from CefLifeSpanHandler::OnBeforePopup on the
  // *opener's* browser and are set before the browser for this tab exists, so
  // OnAfterCreated needs no extra bookkeeping: the tab already knows.
  //   opener_id   — the tab whose page asked for a new window ("" if none)
  //   window_name — window.open(name) / <a target="name"> ("" if none)
  std::string opener_id;
  std::string window_name;

  CefRefPtr<CefBrowser> browser;
  GtkWidget* host = nullptr;         // GtkDrawingArea pinned to the root visual
  GtkWidget* item = nullptr;         // GtkEventBox in the tab strip
  GtkWidget* title_label = nullptr;

  // CDP messages that arrive before OnAfterCreated hand us a browser. CEF
  // creates browsers asynchronously, and a bridge sends Page.enable the
  // instant createTab returns.
  std::vector<std::string> pending_cdp;

  // Visibility. A tab is visible when the user is looking at it *or* an agent
  // round is driving it (CDP needs a rendered page). Parked = hidden.
  bool ui_visible = false;
  bool cdp_awake = false;
  bool hidden_applied = false;
  int64_t last_cdp_us = 0;
};

struct Space {
  std::string id;
  std::string name;
  std::string slug;
  std::string cache_path;
  bool is_user = false;
  bool closing = false;
  int color = 0;                     // avatar colour slot
  CefRefPtr<CefRequestContext> context;  // null => the global ("You") context
  std::vector<std::unique_ptr<Tab>> tabs;
  Tab* active = nullptr;
  GtkWidget* row = nullptr;
  GtkWidget* name_label = nullptr;
  GtkWidget* meta_label = nullptr;

  // Ownership drives the banner and the agent-mutation gate: an agent may not
  // drive a space the user has taken control of.
  std::string ownership = "agent";   // "agent" | "user"
  std::string agent_state;           // setAgentTaskState, shown in the sidebar
};

class Shell {
 public:
  explicit Shell(const Options& options);
  ~Shell();

  bool Start(std::string* error);
  void StartControlServer();
  void TearDown();
  int exit_code() const { return exit_code_; }
  void RequestClose();

  // ---- CEF callbacks (UI thread) ----
  void OnBrowserCreated(const std::string& tab_id, CefRefPtr<CefBrowser> browser);
  void OnBrowserClosed(const std::string& tab_id);
  void OnLoadEnd(const std::string& tab_id,
                 const std::string& url,
                 int http_status);
  void OnLoadError(const std::string& tab_id,
                   int error_code,
                   const std::string& error_text,
                   const std::string& failed_url);
  void OnNavState(const std::string& tab_id,
                  bool loading,
                  bool can_back,
                  bool can_forward);
  void OnTitleChange(const std::string& tab_id, const std::string& title);
  void OnAddressChange(const std::string& tab_id, const std::string& url);
  // CefLifeSpanHandler::OnBeforePopup, reported by the *opener* tab's client.
  // `opener_tab_id` therefore is true provenance: CEF named the source browser.
  void OnOpenPopup(const std::string& opener_tab_id,
                   const std::string& url,
                   const std::string& window_name);
  void OnTabHostResized(const std::string& tab_id, int width, int height);
  void OnConsoleMessage(const std::string& tab_id, const std::string& message);
  // Raw DevTools protocol message from BrowserClient's observer.
  void OnDevToolsMessage(const std::string& tab_id, const std::string& message);

  // ---- model ----
  Tab* FindTab(const std::string& tab_id) const;
  Space* FindSpace(const std::string& space_id) const;
  Space* active_space() const { return active_space_; }
  Tab* active_tab() const { return active_space_ != nullptr ? active_space_->active : nullptr; }
  std::string StateJson() const;
  std::string SpacesJson() const;
  std::string TabsJson(const std::string& space_id) const;
  std::string WelcomeUrl();

  // ---- actions (UI and control delegate share these) ----
  Space* CreateSpace(const std::string& name, bool is_user);
  void ActivateSpace(Space* space);
  // `reveal_space` false activates the tab inside its space without pulling the
  // window over to it (what an agent's switchTab must do). `opener`/`window_name`
  // are set for a tab CEF reported a popup for (see Tab::opener_id).
  Tab* OpenTab(Space* space,
               const std::string& url,
               bool activate,
               bool reveal_space = true,
               Tab* opener = nullptr,
               const std::string& window_name = std::string());
  void ActivateTab(Tab* tab, bool reveal_space = true);
  void CloseTab(Tab* tab);
  void CloseSpace(Space* space);
  void Navigate(Tab* tab, const std::string& url);

  // ---- agent-facing state (control delegate) ----
  void HandOffSpace(Space* space);
  void TakeOverSpace(Space* space);
  void SetAgentState(Space* space, const std::string& state);
  bool HighlightMouse(Space* space, int x, int y);
  // Hands `message` to the tab's browser untouched; false when it cannot be
  // taken (no browser yet and the queue is full, or CEF refused it).
  bool SendCdpMessage(Tab* tab, const std::string& message);

  // ---- UI intents (wired to widgets) ----
  void UiNewTab();
  void UiNewSpace();
  void UiCloseActiveTab();
  void UiBack();
  void UiForward();
  void UiReload();
  void UiNavigateFromEntry(const std::string& text);
  void UiFocusAddressBar();

 private:
  void BuildWindow();
  GtkWidget* BuildSidebar();
  GtkWidget* BuildTabStrip();
  GtkWidget* BuildToolbar();
  GtkWidget* BuildContent();
  GtkWidget* BuildBanner();
  void AddSpaceRow(Space* space);
  GtkWidget* CreateTabItem(Tab* tab);
  void CreateBrowserForTab(Tab* tab);
  void DestroyTab(Tab* tab);
  void DestroySpace(Space* space);
  void UpdateSpaceRow(Space* space);
  void UpdateTabItem(Tab* tab);
  void UpdateVisibility();
  void ApplyVisibility(Tab* tab);
  void UpdateToolbar();
  void UpdateWindowTitle();
  void UpdateBanner();
  void PumpGtk();

  // ---- lifecycle pushes (see control.h / README "Lifecycle pushes") ----
  // Emitted from the model methods below, so a GTK click and an RPC request
  // produce the same events. No-op until StartControlServer has run.
  //
  // Queued, not written on the spot. `ActivateTab` pumps the GTK loop, which can
  // service a control-socket request in the middle of an operation; writing an
  // event there would let a client read a half-applied model (a popup before its
  // space's active tab was restored). Every model action therefore runs inside
  // an OpScope, and the queue is written when the outermost one returns.
  struct PendingEvent {
    std::string method;
    std::string params;
  };
  class OpScope {
   public:
    explicit OpScope(Shell* shell) : shell_(shell) { ++shell_->op_depth_; }
    ~OpScope() {
      if (--shell_->op_depth_ == 0) {
        shell_->FlushEvents();
      }
    }
    OpScope(const OpScope&) = delete;
    OpScope& operator=(const OpScope&) = delete;

   private:
    Shell* shell_;
  };
  void PushEvent(const std::string& method, const std::string& params_json);
  // Writes everything queued, in order (and cancels a pending idle flush).
  void FlushEvents();
  void PushTabCreated(Tab* tab);
  // Emits tab.updated with only the fields that actually changed.
  void PushTabUpdated(Tab* tab, bool url_changed, bool title_changed);
  void PushTabActivated(Tab* tab);
  void PushTabClosed(const Space* space, const std::string& tab_id);

  void CdpKeepAwake(Tab* tab);
  void StartCdpSweep();
  bool CdpSweepTick();

  void BeginShutdown();
  void Finish(int code);

  void StartScreenshotFlow();
  bool ScreenshotTick();
  void PrintIsolationReport();
  void CaptureAndFinish();

  Options options_;
  std::string data_home_;
  std::string app_dir_;

  GtkWidget* window_ = nullptr;
  GtkWidget* space_list_ = nullptr;   // GtkBox of space rows
  GtkWidget* tab_box_ = nullptr;      // GtkBox of tab items
  GtkWidget* content_ = nullptr;      // GtkStack of tab hosts
  GtkWidget* banner_ = nullptr;       // handoff banner, hidden by default
  GtkWidget* banner_label_ = nullptr;
  GtkWidget* url_entry_ = nullptr;
  GtkWidget* back_button_ = nullptr;
  GtkWidget* forward_button_ = nullptr;
  GtkWidget* reload_button_ = nullptr;

  std::vector<std::unique_ptr<Space>> spaces_;
  Space* active_space_ = nullptr;
  int next_space_ = 1;
  int next_tab_ = 1;
  int space_rows_ = 0;
  int open_browsers_ = 0;
  bool shutting_down_ = false;
  int exit_code_ = 0;
  GdkVisual* root_visual_ = nullptr;
  MouseHighlight highlight_;

  std::unique_ptr<ControlServer> control_;
  class ControlAdapter;
  std::unique_ptr<ControlAdapter> control_adapter_;

  // Sweeper that re-parks tabs an agent round woke up (see CdpKeepAwake).
  guint cdp_sweep_source_ = 0;
  // Queued lifecycle pushes; flushed by FlushEvents.
  std::vector<PendingEvent> pending_events_;
  guint event_flush_source_ = 0;
  int op_depth_ = 0;
  // Last-resort exit when a browser refuses to close (see BeginShutdown).
  guint shutdown_watchdog_ = 0;

  // Screenshot run state.
  enum class ShotPhase { kIdle, kWaitLoads, kSettle, kCapture };
  ShotPhase shot_phase_ = ShotPhase::kIdle;
  int64_t shot_start_us_ = 0;
  int64_t settle_until_us_ = 0;
  // Space id -> storage report logged by the page (see fixtures/isolation.html).
  std::map<std::string, std::string> storage_reports_;
  guint shot_source_ = 0;
};

}  // namespace rook
