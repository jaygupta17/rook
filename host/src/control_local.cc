// M1 control server: the delegate is live, the transport is not.
//
// Kept as the `--no-control-socket` fallback: two instances of the app can
// share a uid, and only one of them may own the socket path. Everything the
// shell does still works; the bridge simply has nothing to connect to.
#include <cstdio>

#include "control.h"

namespace rook {
namespace {

class LocalControlServer : public ControlServer {
 public:
  bool Start(const std::string& socket_path, ControlDelegate* delegate) override {
    delegate_ = delegate;
    std::fprintf(stderr,
                 "[control] transport disabled (--no-control-socket); would have been %s\n",
                 socket_path.c_str());
    return false;
  }

  void Stop() override { delegate_ = nullptr; }

  std::string Name() const override { return "local-noop"; }

  void PushCdpEvent(const std::string& browser_id, const std::string& message) override {
    (void)browser_id;
    (void)message;
  }

  void PushCdpError(const std::string& browser_id,
                    int code,
                    const std::string& message,
                    const std::string& reason) override {
    (void)browser_id;
    (void)code;
    (void)message;
    (void)reason;
  }

  void PushEvent(const std::string& method, const std::string& params_json) override {
    (void)method;
    (void)params_json;
  }

 private:
  ControlDelegate* delegate_ = nullptr;
};

}  // namespace

std::unique_ptr<ControlServer> MakeLocalControlServer() {
  return std::unique_ptr<ControlServer>(new LocalControlServer());
}

}  // namespace rook
