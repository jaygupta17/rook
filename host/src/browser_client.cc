#include "browser_client.h"

#include <cstdio>

#include "include/wrapper/cef_helpers.h"

#include "shell.h"

namespace rook {

void BrowserClient::OnAfterCreated(CefRefPtr<CefBrowser> browser) {
  CEF_REQUIRE_UI_THREAD();
  // Registered here, not in the constructor: the observer is per browser, and
  // the registration has to be dropped before the browser goes away.
  devtools_registration_ = browser->GetHost()->AddDevToolsMessageObserver(this);
  if (shell_ != nullptr) {
    shell_->OnBrowserCreated(tab_id_, browser);
  }
}

bool BrowserClient::OnDevToolsMessage(CefRefPtr<CefBrowser> browser,
                                      const void* message,
                                      size_t message_size) {
  CEF_REQUIRE_UI_THREAD();
  (void)browser;
  if (shell_ != nullptr && message != nullptr && message_size > 0) {
    // Verbatim bytes. No parse, no re-encode, no key reordering: the bridge
    // matches replies by the id it chose and sessions by Chromium's sessionId.
    shell_->OnDevToolsMessage(
        tab_id_, std::string(static_cast<const char*>(message), message_size));
  }
  return true;  // handled: do not also fire OnDevToolsMethodResult/Event
}

bool BrowserClient::OnSetFocus(CefRefPtr<CefBrowser> browser, FocusSource source) {
  CEF_REQUIRE_UI_THREAD();
  (void)browser;
  (void)source;
  if (shell_ != nullptr) {
    shell_->OnBrowserFocus(tab_id_);
  }
  return false;  // not handled here: Chromium keeps its own focus state
}

bool BrowserClient::DoClose(CefRefPtr<CefBrowser> browser) {
  CEF_REQUIRE_UI_THREAD();
  // Let the close proceed; OnBeforeClose tears the tab down.
  return false;
}

void BrowserClient::OnBeforeClose(CefRefPtr<CefBrowser> browser) {
  CEF_REQUIRE_UI_THREAD();
  // Release the observer registration while the browser host still exists.
  devtools_registration_ = nullptr;
  if (shell_ != nullptr) {
    shell_->OnBrowserClosed(tab_id_);
  }
}

bool BrowserClient::OnBeforePopup(CefRefPtr<CefBrowser> browser,
                                  CefRefPtr<CefFrame> frame,
                                  int popup_id,
                                  const CefString& target_url,
                                  const CefString& target_frame_name,
                                  CefLifeSpanHandler::WindowOpenDisposition disposition,
                                  bool user_gesture,
                                  const CefPopupFeatures& popup_features,
                                  CefWindowInfo& window_info,
                                  CefRefPtr<CefClient>& client,
                                  CefBrowserSettings& settings,
                                  CefRefPtr<CefDictionaryValue>& extra_info,
                                  bool* no_javascript_access) {
  CEF_REQUIRE_UI_THREAD();
  // There are no native popup windows: the request is turned into a tab of the
  // opener's own space. Cancelling here is what makes the opener identity
  // *knowable* — this callback runs on the opener's browser and its client, so
  // `tab_id_` is the opener and `target_frame_name` is the window name the page
  // asked for ("" for a bare window.open(), "_blank" for <a target="_blank">).
  //
  // What we cannot do this way: let the page keep a handle. The popup browser
  // is never created, so its targetInfo has no canAccessOpener/openerId and
  // `window.opener` is null in the new tab. The bridge has to synthesise the
  // CDP target relationship from tab.created's openerTabId.
  //
  // target_url is empty for window.open() with no URL: the tab gets about:blank
  // rather than being dropped, so the lifecycle is still observable.
  if (shell_ != nullptr) {
    shell_->OnOpenPopup(tab_id_, target_url.ToString(), target_frame_name.ToString());
  } else {
    std::fprintf(stderr, "[rook] popup for %s ignored: browser client has no shell\n",
                 target_url.ToString().c_str());
  }
  return true;  // cancel the native popup
}

void BrowserClient::OnLoadEnd(CefRefPtr<CefBrowser> browser,
                              CefRefPtr<CefFrame> frame,
                              int http_status_code) {
  CEF_REQUIRE_UI_THREAD();
  if (shell_ != nullptr && frame.get() != nullptr && frame->IsMain()) {
    shell_->OnLoadEnd(tab_id_, frame->GetURL().ToString(), http_status_code);
  }
}

void BrowserClient::OnLoadError(CefRefPtr<CefBrowser> browser,
                                CefRefPtr<CefFrame> frame,
                                ErrorCode error_code,
                                const CefString& error_text,
                                const CefString& failed_url) {
  CEF_REQUIRE_UI_THREAD();
  if (shell_ == nullptr || frame.get() == nullptr || !frame->IsMain()) {
    return;
  }
  // ERR_ABORTED is what a superseded navigation reports; not a real failure.
  if (error_code == ERR_ABORTED) {
    return;
  }
  shell_->OnLoadError(tab_id_, static_cast<int>(error_code), error_text.ToString(),
                      failed_url.ToString());
}

void BrowserClient::OnLoadingStateChange(CefRefPtr<CefBrowser> browser,
                                         bool is_loading,
                                         bool can_go_back,
                                         bool can_go_forward) {
  CEF_REQUIRE_UI_THREAD();
  if (shell_ != nullptr) {
    shell_->OnNavState(tab_id_, is_loading, can_go_back, can_go_forward);
  }
}

void BrowserClient::OnTitleChange(CefRefPtr<CefBrowser> browser,
                                  const CefString& title) {
  CEF_REQUIRE_UI_THREAD();
  if (shell_ != nullptr) {
    shell_->OnTitleChange(tab_id_, title.ToString());
  }
}

bool BrowserClient::OnConsoleMessage(CefRefPtr<CefBrowser> browser,
                                     cef_log_severity_t level,
                                     const CefString& message,
                                     const CefString& source,
                                     int line) {
  CEF_REQUIRE_UI_THREAD();
  if (shell_ != nullptr) {
    shell_->OnConsoleMessage(tab_id_, message.ToString());
  }
  return false;  // also let CEF log it
}

void BrowserClient::OnAddressChange(CefRefPtr<CefBrowser> browser,
                                    CefRefPtr<CefFrame> frame,
                                    const CefString& url) {
  CEF_REQUIRE_UI_THREAD();
  if (shell_ != nullptr && frame.get() != nullptr && frame->IsMain()) {
    shell_->OnAddressChange(tab_id_, url.ToString());
  }
}

}  // namespace rook

