// Command line surface of the host binary.
#pragma once

#include <string>
#include <vector>

namespace rook {

struct SpaceSpec {
  std::string name;
  std::vector<std::string> urls;
};

struct Options {
  std::string profile = "default";
  std::string data_root;      // empty => $XDG_DATA_HOME / ~/.local/share
  std::string screenshot;     // non-empty => demo run + capture + exit
  std::string initial_url;    // user tab when no "You" space is given
  std::vector<SpaceSpec> spaces;
  int width = 1280;
  int height = 820;
  bool verify_isolation = false;
  bool control_socket = true;  // M2 unix socket (--no-control-socket disables)
  bool verbose = false;
  bool help = false;

  // Derived in ParseCommandLine().
  std::string profile_dir;  // <data_root>/rook/profiles/<profile>
  std::string log_file;     // <profile_dir>/cef.log
  std::string socket_path;  // $XDG_RUNTIME_DIR/rook-<uid>.sock
};

// Parses rook flags, leaves everything else (CEF switches, positional URL) in
// `rest` so it can be handed to GTK and CefMainArgs untouched.
bool ParseCommandLine(int argc,
                      char** argv,
                      Options* options,
                      std::vector<std::string>* rest,
                      std::string* error);

void PrintUsage(const char* argv0);

}  // namespace rook
