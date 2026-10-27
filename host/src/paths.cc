#include "paths.h"

#include <dirent.h>
#include <limits.h>
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <cctype>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <utility>
#include <vector>

namespace rook {
namespace {

std::string DirName(const std::string& path) {
  const size_t slash = path.find_last_of('/');
  if (slash == std::string::npos) {
    return std::string(".");
  }
  if (slash == 0) {
    return std::string("/");
  }
  return path.substr(0, slash);
}

}  // namespace

std::string ExecutablePath() {
  char buf[PATH_MAX];
  const ssize_t len = readlink("/proc/self/exe", buf, sizeof(buf) - 1);
  if (len <= 0) {
    return std::string();
  }
  buf[len] = '\0';
  return std::string(buf);
}

std::string DataRoot(const std::string& override_root) {
  if (!override_root.empty()) {
    return override_root;
  }
  if (const char* xdg = std::getenv("XDG_DATA_HOME")) {
    if (xdg[0] != '\0') {
      return std::string(xdg);
    }
  }
  if (const char* home = std::getenv("HOME")) {
    if (home[0] != '\0') {
      return std::string(home) + "/.local/share";
    }
  }
  return std::string("/tmp");
}

std::string RuntimeRoot() {
  if (const char* dir = std::getenv("XDG_RUNTIME_DIR")) {
    if (dir[0] != '\0') {
      return std::string(dir);
    }
  }
  return std::string("/tmp");
}

std::string JoinPath(const std::string& a, const std::string& b) {
  if (a.empty()) {
    return b;
  }
  if (b.empty()) {
    return a;
  }
  if (a.back() == '/') {
    return a + b;
  }
  return a + "/" + b;
}

std::string Slugify(const std::string& name) {
  std::string out;
  bool last_dash = true;  // leading dashes are dropped
  for (const char c : Trim(name)) {
    const bool alnum = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
                       (c >= 'A' && c <= 'Z');
    if (alnum) {
      out.push_back(static_cast<char>(c >= 'A' && c <= 'Z' ? c - 'A' + 'a' : c));
      last_dash = false;
    } else if (!last_dash) {
      out.push_back('-');
      last_dash = true;
    }
  }
  while (!out.empty() && out.back() == '-') {
    out.pop_back();
  }
  if (out.empty()) {
    out = "space";
  }
  return out;
}

bool MakeDirs(const std::string& path) {
  if (path.empty()) {
    return false;
  }
  std::string partial;
  size_t pos = 0;
  while (pos <= path.size()) {
    const size_t next = path.find('/', pos);
    const size_t end = next == std::string::npos ? path.size() : next;
    partial = path.substr(0, end);
    pos = end + 1;
    if (partial.empty() || partial == "/.") {
      continue;
    }
    if (::mkdir(partial.c_str(), 0700) != 0 && errno != EEXIST) {
      return false;
    }
    if (next == std::string::npos) {
      break;
    }
  }
  return true;
}

bool FileExists(const std::string& path) {
  struct stat st {};
  return ::stat(path.c_str(), &st) == 0;
}

namespace {

bool RemoveTreeInner(const std::string& path, int depth) {
  struct stat st {};
  if (::lstat(path.c_str(), &st) != 0) {
    return errno == ENOENT;
  }
  if (!S_ISDIR(st.st_mode)) {
    return ::unlink(path.c_str()) == 0 || errno == ENOENT;
  }
  if (depth > 32) {
    return false;  // a symlink loop, not a directory tree
  }
  DIR* dir = ::opendir(path.c_str());
  if (dir == nullptr) {
    return false;
  }
  bool ok = true;
  struct dirent* entry = nullptr;
  while ((entry = ::readdir(dir)) != nullptr) {
    const std::string name(entry->d_name);
    if (name == "." || name == "..") {
      continue;
    }
    if (!RemoveTreeInner(JoinPath(path, name), depth + 1)) {
      ok = false;
    }
  }
  ::closedir(dir);
  if (!ok) {
    return false;
  }
  return ::rmdir(path.c_str()) == 0 || errno == ENOENT;
}

}  // namespace

bool RemoveTree(const std::string& path) { return RemoveTreeInner(path, 0); }

std::vector<std::string> ChildDirs(const std::string& path) {
  std::vector<std::string> out;
  DIR* dir = ::opendir(path.c_str());
  if (dir == nullptr) {
    return out;
  }
  struct dirent* entry = nullptr;
  while ((entry = ::readdir(dir)) != nullptr) {
    const std::string name(entry->d_name);
    if (name == "." || name == "..") {
      continue;
    }
    struct stat st {};
    const std::string full = JoinPath(path, name);
    if (::lstat(full.c_str(), &st) == 0 && S_ISDIR(st.st_mode)) {
      out.push_back(name);
    }
  }
  ::closedir(dir);
  std::sort(out.begin(), out.end());
  return out;
}

std::vector<std::string> ChildNames(const std::string& path) {
  std::vector<std::string> out;
  DIR* dir = ::opendir(path.c_str());
  if (dir == nullptr) {
    return out;
  }
  struct dirent* entry = nullptr;
  while ((entry = ::readdir(dir)) != nullptr) {
    const std::string name(entry->d_name);
    if (name == "." || name == "..") {
      continue;
    }
    out.push_back(name);
  }
  ::closedir(dir);
  std::sort(out.begin(), out.end());
  return out;
}

long long FileSize(const std::string& path) {
  struct stat st {};
  if (::stat(path.c_str(), &st) != 0) {
    return -1;
  }
  return static_cast<long long>(st.st_size);
}

std::string Trim(const std::string& s) {
  size_t begin = 0;
  size_t end = s.size();
  while (begin < end && std::isspace(static_cast<unsigned char>(s[begin]))) {
    ++begin;
  }
  while (end > begin && std::isspace(static_cast<unsigned char>(s[end - 1]))) {
    --end;
  }
  return s.substr(begin, end - begin);
}

bool StartsWith(const std::string& s, const std::string& prefix) {
  return s.size() >= prefix.size() && s.compare(0, prefix.size(), prefix) == 0;
}

std::string CefRuntimeDir() {
  if (const char* env = std::getenv("ROOK_CEF_RUNTIME")) {
    if (env[0] != '\0') {
      return std::string(env);
    }
  }
#ifdef ROOK_DEFAULT_CEF_RUNTIME
  const std::string staged = ROOK_DEFAULT_CEF_RUNTIME;
  if (FileExists(JoinPath(staged, "libcef.so"))) {
    return staged;
  }
#endif
  const std::string exe = ExecutablePath();
  return exe.empty() ? std::string(".") : DirName(exe);
}

}  // namespace rook
