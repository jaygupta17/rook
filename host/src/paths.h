// Small filesystem helpers shared by the shell. No GLib cleverness: the shell
// runs on a single thread and only touches a handful of paths.
#pragma once

#include <string>
#include <vector>

namespace rook {

std::string ExecutablePath();

// $XDG_DATA_HOME, defaulting to $HOME/.local/share.
std::string DataRoot(const std::string& override_root);

// $XDG_RUNTIME_DIR, defaulting to /tmp.
std::string RuntimeRoot();

std::string JoinPath(const std::string& a, const std::string& b);

// "Agent 1" -> "agent-1". Always non-empty and safe as a directory name.
std::string Slugify(const std::string& name);

bool MakeDirs(const std::string& path);
bool FileExists(const std::string& path);
long long FileSize(const std::string& path);

std::string Trim(const std::string& s);
bool StartsWith(const std::string& s, const std::string& prefix);

// CEF's runtime files live next to libcef.so. Resolution order:
// ROOK_CEF_RUNTIME env, the compile-time staging dir, then the executable's dir.
std::string CefRuntimeDir();

}  // namespace rook
