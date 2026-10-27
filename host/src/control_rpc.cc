// M2 control transport: newline-delimited JSON-RPC 2.0 on a unix socket.
//
// Design notes that matter:
//
//  * Everything runs on the UI thread. The listening socket and every client
//    fd are GLib fd sources, so a request is parsed, dispatched and answered
//    inside the same loop that pumps GTK and CEF. No locks, no marshalling,
//    and a request can touch widgets and CefBrowserHost directly.
//  * One request in, exactly one reply out, matched by the client's own id.
//    The id is echoed as the exact JSON token the client sent (int or string).
//  * CDP is not a request/response protocol here: the host pushes
//    `cdp.event` / `cdp.error` notifications and the only request is
//    `cdp.send`. Payloads are opaque strings — the host does not parse or
//    rewrite them (see Shell::SendCdpMessage / BrowserClient::OnDevToolsMessage).
//  * Writes never block: bytes that do not fit stay in Client::out and an
//    G_IO_OUT source flushes them. A slow client therefore cannot stall the UI.
#include "control.h"

#include <errno.h>
#include <fcntl.h>
#include <glib-unix.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#include <cstddef>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#include "include/cef_parser.h"
#include "include/cef_version.h"
#include "json.h"

namespace rook {
namespace {

constexpr const char* kHostVersion = "0.3.0-M3";
// 2: adds the tab/space/ownership lifecycle pushes and `activateSpace`.
// A protocol-1 bridge keeps working: it just never sees the new pushes.
constexpr const char* kProtocol = "2";

// A Page.captureScreenshot reply is base64 and can be a few MB. Anything past
// this is a client bug, not a message.
constexpr size_t kMaxLineBytes = 96u * 1024u * 1024u;
constexpr size_t kMaxQueuedBytes = 64u * 1024u * 1024u;

// JSON-RPC 2.0 error codes, plus the two the host invents.
constexpr int kParseError = -32700;
constexpr int kInvalidRequest = -32600;
constexpr int kMethodNotFound = -32601;
constexpr int kInvalidParams = -32602;
constexpr int kHostError = -32001;   // the host refused: unknown id, handed off
constexpr int kCdpError = -32002;    // the CDP broker could not take the message

struct Reply {
  bool ok = true;
  std::string result;   // `result` value when ok
  int code = 0;         // error code when !ok
  std::string error;    // error message when !ok
};

Reply Ok(std::string result) { return Reply{true, std::move(result), 0, std::string()}; }
Reply Err(int code, std::string error) {
  return Reply{false, std::string(), code, std::move(error)};
}

bool ParamString(CefRefPtr<CefDictionaryValue> params,
                 const char* key,
                 std::string* out) {
  if (!params || !params->HasKey(key)) {
    return false;
  }
  CefRefPtr<CefValue> value = params->GetValue(key);
  if (!value || value->GetType() != VTYPE_STRING) {
    return false;
  }
  *out = value->GetString().ToString();
  return true;
}

bool ParamInt(CefRefPtr<CefDictionaryValue> params, const char* key, int* out) {
  if (!params || !params->HasKey(key)) {
    return false;
  }
  CefRefPtr<CefValue> value = params->GetValue(key);
  if (!value) {
    return false;
  }
  switch (value->GetType()) {
    case VTYPE_INT:
      *out = value->GetInt();
      return true;
    case VTYPE_DOUBLE:
      *out = static_cast<int>(value->GetDouble());
      return true;
    default:
      return false;
  }
}

struct Client {
  int fd = -1;
  std::string in;      // bytes received, not yet split into lines
  std::string out;     // bytes waiting for the socket
  guint in_source = 0;
  guint out_source = 0;
  bool dead = false;
};

class SocketControlServer : public ControlServer {
 public:
  bool Start(const std::string& socket_path, ControlDelegate* delegate) override;
  void Stop() override;
  std::string Name() const override { return "unix-jsonrpc"; }

  void PushCdpEvent(const std::string& browser_id,
                    const std::string& message) override {
    PushNotification("cdp.event", browser_id,
                     "\"message\":\"" + JsonEscape(message) + "\"");
  }

  void PushCdpError(const std::string& browser_id,
                    int code,
                    const std::string& message) override {
    PushNotification("cdp.error", browser_id,
                     "\"code\":" + std::to_string(code) + ",\"message\":\"" +
                         JsonEscape(message) + "\"");
  }

  // Lifecycle pushes carry whatever object the shell built; no browserId is
  // grafted on (a space event has no browser, and inventing one would make the
  // bridge filter on a field that means nothing).
  void PushEvent(const std::string& method,
                 const std::string& params_json) override {
    Broadcast(Notification(method, params_json));
  }

 private:
  // --- socket setup ---------------------------------------------------------
  bool Bind(const std::string& path);
  void Reap();

  // --- GLib callbacks -------------------------------------------------------
  static gboolean OnAccept(gint fd, GIOCondition condition, gpointer data);
  static gboolean OnReadable(gint fd, GIOCondition condition, gpointer data);
  static gboolean OnWritable(gint fd, GIOCondition condition, gpointer data);

  // --- clients --------------------------------------------------------------
  Client* Find(int fd) const;
  void Adopt(int fd);
  void CloseClient(Client* client);
  void Flush(Client* client);
  void Send(Client* client, const std::string& line);
  void SendReply(Client* client, const std::string& id_json, const Reply& reply);
  static std::string Notification(const std::string& method,
                                  const std::string& params_json);
  void Broadcast(const std::string& line);
  void PushNotification(const std::string& method,
                        const std::string& browser_id,
                        const std::string& extra_fields);
  void Drain(Client* client);

  // --- dispatch -------------------------------------------------------------
  void HandleLine(Client* client, const std::string& line);
  Reply Invoke(const std::string& method,
               CefRefPtr<CefDictionaryValue> params,
               bool* known);

  ControlDelegate* delegate_ = nullptr;
  std::string socket_path_;
  int listen_fd_ = -1;
  guint accept_source_ = 0;
  std::vector<std::unique_ptr<Client>> clients_;
};

bool SocketControlServer::Start(const std::string& socket_path,
                                ControlDelegate* delegate) {
  if (delegate != nullptr && listen_fd_ >= 0) {
    return true;  // already listening
  }
  delegate_ = delegate;
  socket_path_ = socket_path;
  return Bind(socket_path);
}

bool SocketControlServer::Bind(const std::string& path) {
  sockaddr_un addr{};
  addr.sun_family = AF_UNIX;
  if (path.size() + 1 > sizeof(addr.sun_path)) {
    std::fprintf(stderr, "[control] socket path too long: %s\n", path.c_str());
    return false;
  }
  std::memcpy(addr.sun_path, path.c_str(), path.size() + 1);
  const socklen_t addr_len = static_cast<socklen_t>(
      offsetof(sockaddr_un, sun_path) + path.size() + 1);

  listen_fd_ = ::socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
  if (listen_fd_ < 0) {
    std::fprintf(stderr, "[control] socket(): %s\n", std::strerror(errno));
    return false;
  }

  // Another instance on the path is a configuration error we can report; a
  // stale socket file (the previous run was killed) is ours to remove. The only
  // way to tell them apart is to try to connect.
  int probe = ::socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (probe >= 0) {
    const bool live = ::connect(probe, reinterpret_cast<sockaddr*>(&addr), addr_len) == 0;
    ::close(probe);
    if (live) {
      std::fprintf(stderr,
                   "[control] another rook already listens on %s; "
                   "pass --socket-path to run a second instance\n",
                   path.c_str());
      ::close(listen_fd_);
      listen_fd_ = -1;
      return false;
    }
  }
  ::unlink(path.c_str());

  if (::bind(listen_fd_, reinterpret_cast<sockaddr*>(&addr), addr_len) != 0) {
    std::fprintf(stderr, "[control] bind(%s): %s\n", path.c_str(), std::strerror(errno));
    ::close(listen_fd_);
    listen_fd_ = -1;
    return false;
  }
  // 0600 before listen(): nobody can race the window where the socket is
  // reachable with the default umask permissions.
  if (::chmod(path.c_str(), S_IRUSR | S_IWUSR) != 0) {
    std::fprintf(stderr, "[control] chmod(%s): %s\n", path.c_str(), std::strerror(errno));
  }
  if (::listen(listen_fd_, 16) != 0) {
    std::fprintf(stderr, "[control] listen(%s): %s\n", path.c_str(), std::strerror(errno));
    ::close(listen_fd_);
    listen_fd_ = -1;
    ::unlink(path.c_str());
    return false;
  }

  accept_source_ = g_unix_fd_add(
      listen_fd_, static_cast<GIOCondition>(G_IO_IN), OnAccept, this);
  std::fprintf(stderr, "[control] listening on %s (mode 0600, JSON-RPC 2.0)\n",
               path.c_str());
  return true;
}

void SocketControlServer::Stop() {
  for (auto& client : clients_) {
    CloseClient(client.get());
  }
  clients_.clear();
  if (accept_source_ != 0) {
    g_source_remove(accept_source_);
    accept_source_ = 0;
  }
  if (listen_fd_ >= 0) {
    ::close(listen_fd_);
    listen_fd_ = -1;
    ::unlink(socket_path_.c_str());
    std::fprintf(stderr, "[control] socket %s removed\n", socket_path_.c_str());
  }
  delegate_ = nullptr;
}

gboolean SocketControlServer::OnAccept(gint fd, GIOCondition condition, gpointer data) {
  auto* self = static_cast<SocketControlServer*>(data);
  (void)condition;
  for (;;) {
    const int client_fd = ::accept4(fd, nullptr, nullptr, SOCK_NONBLOCK | SOCK_CLOEXEC);
    if (client_fd < 0) {
      if (errno == EINTR) {
        continue;
      }
      break;  // EAGAIN when the backlog is empty; anything else is transient
    }
    self->Adopt(client_fd);
  }
  self->Reap();
  return G_SOURCE_CONTINUE;
}

void SocketControlServer::Adopt(int fd) {
  Client* client = clients_.emplace_back(std::make_unique<Client>()).get();
  client->fd = fd;
  client->in_source = g_unix_fd_add(
      fd, static_cast<GIOCondition>(G_IO_IN | G_IO_HUP | G_IO_ERR), OnReadable, this);
}

Client* SocketControlServer::Find(int fd) const {
  for (const auto& client : clients_) {
    if (client->fd == fd && !client->dead) {
      return client.get();
    }
  }
  return nullptr;
}

void SocketControlServer::CloseClient(Client* client) {
  if (client == nullptr || client->dead) {
    return;
  }
  client->dead = true;
  if (client->in_source != 0) {
    g_source_remove(client->in_source);
    client->in_source = 0;
  }
  if (client->out_source != 0) {
    g_source_remove(client->out_source);
    client->out_source = 0;
  }
  if (client->fd >= 0) {
    ::close(client->fd);  // GLib fd sources do not own the descriptor
    client->fd = -1;
  }
}

void SocketControlServer::Reap() {
  for (auto it = clients_.begin(); it != clients_.end();) {
    if ((*it)->dead) {
      it = clients_.erase(it);
    } else {
      ++it;
    }
  }
}

gboolean SocketControlServer::OnReadable(gint fd, GIOCondition condition, gpointer data) {
  auto* self = static_cast<SocketControlServer*>(data);
  self->Reap();
  Client* client = self->Find(fd);
  if (client == nullptr) {
    return G_SOURCE_REMOVE;
  }
  if ((condition & (G_IO_ERR | G_IO_NVAL)) != 0) {
    self->CloseClient(client);
    return G_SOURCE_REMOVE;
  }
  // G_IO_HUP is deliberately not handled here: a peer that writes a last
  // request and disconnects sets IN|HUP together, and read() == 0 (below) is
  // the only point where the buffered bytes are known to be drained.

  char buffer[65536];
  for (;;) {
    const ssize_t read_bytes = ::read(fd, buffer, sizeof(buffer));
    if (read_bytes > 0) {
      client->in.append(buffer, static_cast<size_t>(read_bytes));
      if (client->in.size() > kMaxLineBytes) {
        std::fprintf(stderr, "[control] client exceeded the line limit; dropping\n");
        self->CloseClient(client);
        return G_SOURCE_REMOVE;
      }
      continue;
    }
    if (read_bytes == 0) {
      // Peer hung up. Bytes that arrived together with the FIN are still
      // requests: a short-lived CLI writes one frame and exits, and that frame
      // must be acted on, so drain what is buffered before dropping the socket.
      self->Drain(client);
      self->CloseClient(client);
      self->Reap();  // `client` is gone from here on; Reap is the last touch
      return G_SOURCE_REMOVE;
    }
    if (errno == EINTR) {
      continue;
    }
    if (errno == EAGAIN || errno == EWOULDBLOCK) {
      break;
    }
    self->CloseClient(client);
    return G_SOURCE_REMOVE;
  }

  self->Drain(client);
  if (client->dead) {
    return G_SOURCE_REMOVE;
  }
  return G_SOURCE_CONTINUE;
}

gboolean SocketControlServer::OnWritable(gint fd, GIOCondition condition, gpointer data) {
  auto* self = static_cast<SocketControlServer*>(data);
  (void)condition;
  Client* client = self->Find(fd);
  if (client == nullptr) {
    return G_SOURCE_REMOVE;
  }
  self->Flush(client);
  if (client->dead || client->out.empty()) {
    // This source is about to be destroyed by returning FALSE; drop the id so
    // CloseClient/Stop never try to remove it a second time (GLib warns).
    client->out_source = 0;
    return G_SOURCE_REMOVE;
  }
  return G_SOURCE_CONTINUE;
}

void SocketControlServer::Flush(Client* client) {
  while (!client->out.empty()) {
    const ssize_t written =
        ::send(client->fd, client->out.data(), client->out.size(), MSG_NOSIGNAL);
    if (written > 0) {
      client->out.erase(0, static_cast<size_t>(written));
      continue;
    }
    if (written < 0 && errno == EINTR) {
      continue;
    }
    if (written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      if (client->out_source == 0) {
        client->out_source =
            g_unix_fd_add(client->fd, static_cast<GIOCondition>(G_IO_OUT), OnWritable, this);
      }
      return;
    }
    CloseClient(client);
    return;
  }
}

void SocketControlServer::Send(Client* client, const std::string& line) {
  if (client == nullptr || client->dead) {
    return;
  }
  if (client->out.size() > kMaxQueuedBytes) {
    std::fprintf(stderr, "[control] client is not reading; dropping it\n");
    CloseClient(client);
    return;
  }
  client->out += line;
  client->out += '\n';
  Flush(client);
}

void SocketControlServer::SendReply(Client* client,
                                    const std::string& id_json,
                                    const Reply& reply) {
  std::string line = "{\"jsonrpc\":\"2.0\",\"id\":";
  line += id_json;
  if (reply.ok) {
    line += ",\"result\":";
    line += reply.result;
  } else {
    line += ",\"error\":{\"code\":";
    line += std::to_string(reply.code);
    line += ",\"message\":\"";
    line += JsonEscape(reply.error);
    line += "\"}";
  }
  line += "}";
  Send(client, line);
}

std::string SocketControlServer::Notification(const std::string& method,
                                              const std::string& params_json) {
  std::string line = "{\"jsonrpc\":\"2.0\",\"method\":\"";
  line += method;
  line += "\",\"params\":";
  line += params_json.empty() ? "{}" : params_json;
  line += "}";
  return line;
}

void SocketControlServer::Broadcast(const std::string& line) {
  if (clients_.empty()) {
    return;
  }
  for (auto& client : clients_) {
    Send(client.get(), line);
  }
  // No Reap() here on purpose. A push is usually emitted from inside a request
  // handler, and Send() can mark a client dead (peer gone). Erasing it now would
  // free the Client whose stack this handler is running on; Drain re-checks
  // client->dead after every line. The next accept/read/stop sweeps instead.
}

void SocketControlServer::PushNotification(const std::string& method,
                                           const std::string& browser_id,
                                           const std::string& extra_fields) {
  Broadcast(Notification(method, "{\"browserId\":\"" + JsonEscape(browser_id) +
                                      "\"," + extra_fields + "}"));
}

void SocketControlServer::Drain(Client* client) {
  size_t start = 0;
  while (start <= client->in.size()) {
    const size_t newline = client->in.find('\n', start);
    if (newline == std::string::npos) {
      break;
    }
    std::string line = client->in.substr(start, newline - start);
    start = newline + 1;
    if (!line.empty() && line.back() == '\r') {
      line.pop_back();
    }
    if (line.empty()) {
      continue;
    }
    HandleLine(client, line);
    if (client->dead) {
      return;
    }
  }
  client->in.erase(0, start);
}

void SocketControlServer::HandleLine(Client* client, const std::string& line) {
  CefRefPtr<CefValue> parsed =
      CefParseJSON(line.data(), line.size(), JSON_PARSER_ALLOW_TRAILING_COMMAS);
  if (!parsed || parsed->GetType() != VTYPE_DICTIONARY) {
    SendReply(client, "null",
              Err(kParseError, "parse error: expected one JSON-RPC object per line"));
    return;
  }
  CefRefPtr<CefDictionaryValue> request = parsed->GetDictionary();

  std::string id_json = "null";
  bool has_id = false;
  if (request->HasKey("id")) {
    CefRefPtr<CefValue> id_value = request->GetValue("id");
    if (id_value && id_value->GetType() != VTYPE_NULL) {
      has_id = true;
      id_json = CefWriteJSON(id_value, JSON_WRITER_DEFAULT).ToString();
    }
  }

  std::string method;
  if (!ParamString(request, "method", &method) || method.empty()) {
    SendReply(client, id_json, Err(kInvalidRequest, "invalid request: no method"));
    return;
  }

  bool known = true;
  const Reply reply = Invoke(method, request->GetDictionary("params"), &known);
  if (!has_id) {
    return;  // a notification: fire and forget
  }
  if (!known) {
    SendReply(client, id_json, Err(kMethodNotFound, "unknown method \"" + method + "\""));
    return;
  }
  SendReply(client, id_json, reply);
}

Reply SocketControlServer::Invoke(const std::string& method,
                                  CefRefPtr<CefDictionaryValue> params,
                                  bool* known) {
  *known = true;

  if (method == "getInfo") {
    std::string result = "{\"version\":\"";
    result += kHostVersion;
    result += "\",\"protocol\":\"";
    result += kProtocol;
    result += "\",\"pid\":";
    result += std::to_string(static_cast<long long>(::getpid()));
    result += ",\"socket\":\"";
    result += JsonEscape(socket_path_);
    result += "\",\"cef\":\"";
    result += CEF_VERSION;
    result += "\",\"state\":";
    result += delegate_->ListState();
    result += "}";
    return Ok(result);
  }

  if (method == "listSpaces") {
    return Ok(delegate_->ListSpaces());
  }

  if (method == "createSpace") {
    std::string name;
    if (!ParamString(params, "name", &name) || name.empty()) {
      return Err(kInvalidParams, "createSpace needs a non-empty string 'name'");
    }
    const std::string space_id = delegate_->CreateSpace(name);
    if (space_id.empty()) {
      return Err(kHostError, "the host could not create a space named \"" + name + "\"");
    }
    return Ok("{\"spaceId\":\"" + JsonEscape(space_id) + "\",\"name\":\"" +
              JsonEscape(name) + "\"}");
  }

  if (method == "closeSpace") {
    std::string space_id;
    if (!ParamString(params, "spaceId", &space_id)) {
      return Err(kInvalidParams, "closeSpace needs a string 'spaceId'");
    }
    const ControlStatus status = delegate_->CloseSpace(space_id);
    if (!status.ok) {
      return Err(kHostError, status.error);
    }
    return Ok("{\"spaceId\":\"" + JsonEscape(space_id) + "\",\"closed\":true}");
  }

  if (method == "listTabs") {
    std::string space_id;
    if (!ParamString(params, "spaceId", &space_id)) {
      return Err(kInvalidParams, "listTabs needs a string 'spaceId'");
    }
    std::string tabs = delegate_->ListTabs(space_id);
    if (tabs.empty()) {
      return Err(kHostError, "no space " + space_id);
    }
    return Ok(tabs);
  }

  if (method == "createTab") {
    std::string space_id;
    if (!ParamString(params, "spaceId", &space_id)) {
      return Err(kInvalidParams, "createTab needs a string 'spaceId'");
    }
    std::string url;
    if (!ParamString(params, "url", &url) || url.empty()) {
      url = "about:blank";
    }
    const std::string tab_id = delegate_->CreateTab(space_id, url);
    if (tab_id.empty()) {
      return Err(kHostError,
                 "the host could not create a tab in " + space_id +
                     " (unknown or closing space, the user's space, or a space "
                     "handed off to the user)");
    }
    return Ok("{\"spaceId\":\"" + JsonEscape(space_id) + "\",\"tabId\":\"" +
              JsonEscape(tab_id) + "\",\"browserId\":\"" + JsonEscape(tab_id) +
              "\",\"url\":\"" + JsonEscape(url) + "\"}");
  }

  if (method == "activateSpace") {
    std::string space_id;
    if (!ParamString(params, "spaceId", &space_id)) {
      return Err(kInvalidParams, "activateSpace needs a string 'spaceId'");
    }
    const ControlStatus status = delegate_->ActivateSpace(space_id);
    if (!status.ok) {
      return Err(kHostError, status.error);
    }
    return Ok("{\"spaceId\":\"" + JsonEscape(space_id) + "\",\"active\":true}");
  }

  if (method == "activateTab" || method == "closeTab") {
    std::string space_id;
    std::string tab_id;
    if (!ParamString(params, "spaceId", &space_id)) {
      return Err(kInvalidParams, method + " needs a string 'spaceId'");
    }
    if (!ParamString(params, "tabId", &tab_id)) {
      return Err(kInvalidParams, method + " needs a string 'tabId'");
    }
    const ControlStatus status = method == "activateTab"
                                     ? delegate_->ActivateTab(space_id, tab_id)
                                     : delegate_->CloseTab(space_id, tab_id);
    if (!status.ok) {
      return Err(kHostError, status.error);
    }
    return Ok("{\"spaceId\":\"" + JsonEscape(space_id) + "\",\"tabId\":\"" +
              JsonEscape(tab_id) + "\",\"" +
              (method == "activateTab" ? "active" : "closed") + "\":true}");
  }

  if (method == "navigate") {
    std::string tab_id;
    std::string url;
    if (!ParamString(params, "tabId", &tab_id)) {
      return Err(kInvalidParams, "navigate needs a string 'tabId'");
    }
    if (!ParamString(params, "url", &url) || url.empty()) {
      return Err(kInvalidParams, "navigate needs a non-empty string 'url'");
    }
    const ControlStatus status = delegate_->Navigate(tab_id, url);
    if (!status.ok) {
      return Err(kHostError, status.error);
    }
    return Ok("{\"tabId\":\"" + JsonEscape(tab_id) + "\",\"url\":\"" +
              JsonEscape(url) + "\"}");
  }

  if (method == "handOff" || method == "takeOver") {
    std::string space_id;
    if (!ParamString(params, "spaceId", &space_id)) {
      return Err(kInvalidParams, method + " needs a string 'spaceId'");
    }
    const ControlStatus status = method == "handOff" ? delegate_->HandOff(space_id)
                                                     : delegate_->TakeOver(space_id);
    if (!status.ok) {
      return Err(kHostError, status.error);
    }
    return Ok("{\"spaceId\":\"" + JsonEscape(space_id) + "\",\"ownership\":\"" +
              (method == "handOff" ? "user" : "agent") + "\"}");
  }

  if (method == "setAgentTaskState") {
    std::string space_id;
    if (!ParamString(params, "spaceId", &space_id)) {
      return Err(kInvalidParams, "setAgentTaskState needs a string 'spaceId'");
    }
    std::string state;
    if (!ParamString(params, "state", &state)) {
      return Err(kInvalidParams, "setAgentTaskState needs a string 'state'");
    }
    const ControlStatus status = delegate_->SetAgentTaskState(space_id, state);
    if (!status.ok) {
      return Err(kHostError, status.error);
    }
    return Ok("{\"spaceId\":\"" + JsonEscape(space_id) + "\",\"agentState\":\"" +
              JsonEscape(state) + "\"}");
  }

  if (method == "highlightMouseTo") {
    std::string space_id;
    if (!ParamString(params, "spaceId", &space_id)) {
      return Err(kInvalidParams, "highlightMouseTo needs a string 'spaceId'");
    }
    int x = 0;
    int y = 0;
    if (!ParamInt(params, "x", &x) || !ParamInt(params, "y", &y)) {
      return Err(kInvalidParams, "highlightMouseTo needs numeric 'x' and 'y'");
    }
    const ControlStatus status = delegate_->HighlightMouseTo(space_id, x, y);
    if (!status.ok) {
      return Err(kHostError, status.error);
    }
    return Ok("{\"spaceId\":\"" + JsonEscape(space_id) + "\",\"x\":" +
              std::to_string(x) + ",\"y\":" + std::to_string(y) + "}");
  }

  if (method == "cdp.send") {
    std::string browser_id;
    std::string message;
    if (!ParamString(params, "browserId", &browser_id)) {
      return Err(kInvalidParams, "cdp.send needs a string 'browserId'");
    }
    if (!ParamString(params, "message", &message) || message.empty()) {
      return Err(kInvalidParams, "cdp.send needs a non-empty string 'message'");
    }
    const ControlStatus status = delegate_->SendCdp(browser_id, message);
    if (!status.ok) {
      // Both: the notification the bridge's onSendCDPMessageError needs, and a
      // synchronous error for clients that only read replies.
      PushCdpError(browser_id, kCdpError, status.error);
      return Err(kCdpError, status.error);
    }
    return Ok("{\"browserId\":\"" + JsonEscape(browser_id) + "\",\"accepted\":true}");
  }

  if (method == "quit") {
    std::fprintf(stderr, "[control] quit requested\n");
    delegate_->Quit();
    return Ok("{\"quitting\":true}");
  }

  *known = false;
  return Reply{};
}

}  // namespace

std::unique_ptr<ControlServer> MakeSocketControlServer() {
  return std::unique_ptr<ControlServer>(new SocketControlServer());
}

}  // namespace rook
