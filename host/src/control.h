// The seam between the bridge and the host.
//
// M1 defined the operations the bridge needs and left the transport stubbed.
// M2 keeps the same shape and adds the two things the bridge actually talks to:
//
//   * ControlDelegate — every operation, addressed by opaque string ids, so the
//     bridge never holds a CEF pointer. The shell implements it once
//     (Shell::ControlAdapter, shell.cc) on top of the *same* Shell methods the
//     GTK handlers call; a UI click and an RPC request cannot diverge.
//   * ControlServer — newline-delimited JSON-RPC 2.0 over a unix socket, plus
//     the push half: the CDP broker's cdp.event / cdp.error and the tab, space
//     and ownership lifecycle events the bridge turns into CDP target events.
//
// Wire format (control_rpc.cc is the authority):
//
//   request   {"jsonrpc":"2.0","id":N,"method":"createTab","params":{...}}
//   reply     {"jsonrpc":"2.0","id":N,"result":{...}}
//             {"jsonrpc":"2.0","id":N,"error":{"code":-32602,"message":"..."}}
//   push      {"jsonrpc":"2.0","method":"cdp.event","params":{"browserId","message"}}
//             {"jsonrpc":"2.0","method":"cdp.error","params":{"browserId","code","message"}}
//             {"jsonrpc":"2.0","method":"tab.created","params":{"spaceId","tabId",...}}
//             ... space.created/closed, tab.closed/activated/updated, control.changed
//
// A push for an operation can reach the client before or after that operation's
// reply: the shell queues events and writes them from an idle callback, so a
// client reacting to one always sees the operation finished.
//
// One JSON object per line, UTF-8, no pretty printing. CDP payloads travel as
// JSON *strings* and are never parsed by the host.
#pragma once

#include <memory>
#include <string>

namespace rook {

// Result of an operation that has no natural return value. `error` is empty on
// success and is the message the RPC error carries when it is not.
struct ControlStatus {
  bool ok = true;
  std::string error;

  static ControlStatus Ok() { return ControlStatus{}; }
  static ControlStatus Fail(std::string why) { return ControlStatus{false, std::move(why)}; }
};

// Operations the bridge needs from the host — the host half of the binding
// table documented in host/README.md. Ids are opaque strings; the
// "browser id" used by the CDP broker is the tab id, so a bridge only ever
// carries one id per page.
class ControlDelegate {
 public:
  virtual ~ControlDelegate() = default;

  // ---- spaces --------------------------------------------------------------
  // createSpace(name) -> space id. New CefRequestContext, no tab yet: the
  // bridge asks for the tabs it wants. "" on failure.
  virtual std::string CreateSpace(const std::string& name) = 0;

  // Closes every browser in the space, releases its request context and drops
  // it from the sidebar. The on-disk profile (cookies/storage) stays.
  virtual ControlStatus CloseSpace(const std::string& space_id) = 0;

  // {"activeSpaceId":"sp1","spaces":[{spaceId,name,user,active,ownership,
  //   agentState,cache,tabCount,activeTabId}]}
  virtual std::string ListSpaces() const = 0;

  // ---- tabs ----------------------------------------------------------------
  // {"spaceId","activeTabId","tabs":[{tabId,browserId,title,url,active,loading,
  //   closing,openerTabId,windowName}]}
  // `openerTabId` is the tab whose page called window.open()/target=_blank
  // ("" when the tab was not opened by a page); `windowName` is that call's
  // window name ("" when none). "" when the space does not exist.
  virtual std::string ListTabs(const std::string& space_id) const = 0;

  // createTab(spaceId, url) -> tab id (== browser id). "" on failure.
  // A tab in a hidden space is created and loaded but does not steal the view.
  virtual std::string CreateTab(const std::string& space_id, const std::string& url) = 0;

  // Shows `space_id` in the window: sidebar selection plus its tab strip, the
  // same path as clicking the row. A view operation, so it is allowed on the
  // user's space and on a handed-off space; it never mutates a tab.
  virtual ControlStatus ActivateSpace(const std::string& space_id) = 0;

  virtual ControlStatus ActivateTab(const std::string& space_id,
                                    const std::string& tab_id) = 0;
  virtual ControlStatus CloseTab(const std::string& space_id,
                                 const std::string& tab_id) = 0;
  virtual ControlStatus Navigate(const std::string& tab_id, const std::string& url) = 0;

  // ---- agent bookkeeping (native banner + mutation gate) -------------------
  virtual ControlStatus HandOff(const std::string& space_id) = 0;
  virtual ControlStatus TakeOver(const std::string& space_id) = 0;
  virtual ControlStatus SetAgentTaskState(const std::string& space_id,
                                          const std::string& state) = 0;
  virtual ControlStatus HighlightMouseTo(const std::string& space_id, int x, int y) = 0;

  // ---- CDP broker ----------------------------------------------------------
  // Raw DevTools protocol JSON, untouched. False = the host could not take it
  // (unknown browser, space handed off, tab closing); the reason is the
  // ControlStatus error.
  virtual ControlStatus SendCdp(const std::string& browser_id,
                                const std::string& message) = 0;

  // ---- info ----------------------------------------------------------------
  // Full snapshot: {"activeSpaceId","spaces":[{...,"tabs":[...]}]}.
  virtual std::string ListState() const = 0;

  // Ask the app to quit (the shell closes its browsers, then exits 0).
  virtual void Quit() = 0;
};

// Transport. One instance per host process.
class ControlServer {
 public:
  virtual ~ControlServer() = default;

  // Non-blocking: binds, listens and hooks the GLib loop. Must tolerate being
  // called before any client exists. Returns false when the socket cannot be
  // opened (another instance owns the path, no permission, ...).
  virtual bool Start(const std::string& socket_path, ControlDelegate* delegate) = 0;
  virtual void Stop() = 0;
  virtual std::string Name() const = 0;

  // CDP broker push. Both are notifications (no id) broadcast to every client;
  // `browser_id` is the tab id, `message` is the DevTools JSON verbatim.
  virtual void PushCdpEvent(const std::string& browser_id,
                            const std::string& message) = 0;
  virtual void PushCdpError(const std::string& browser_id,
                            int code,
                            const std::string& message) = 0;

  // Lifecycle push: a notification (no id) broadcast to every client, with the
  // `params` object the shell built (already-serialised JSON object text).
  // Methods and payloads are documented in README.md ("Lifecycle pushes").
  virtual void PushEvent(const std::string& method,
                         const std::string& params_json) = 0;
};

// M2: unix socket + JSON-RPC. This is what the shipping host uses.
std::unique_ptr<ControlServer> MakeSocketControlServer();

// M1 fallback (--no-control-socket): delegate wired, no transport. Useful when
// two instances of the app share a uid and only one may own the socket.
std::unique_ptr<ControlServer> MakeLocalControlServer();

}  // namespace rook
