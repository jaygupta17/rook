// JSON string escaping for hand-built payloads.
//
// The host never needs a JSON *parser* on the shell side: requests arrive as
// CefValue trees (control_rpc.cc), and everything the shell emits is a fixed
// shape with user text spliced in. Splice it through here so quotes, newlines
// and control bytes from the web cannot break the frame.
#pragma once

#include <cstdio>
#include <string>

namespace rook {

inline std::string JsonEscape(const std::string& value) {
  std::string out;
  out.reserve(value.size() + 8);
  for (const unsigned char c : value) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", c);
          out += buf;
        } else {
          out.push_back(static_cast<char>(c));
        }
    }
  }
  return out;
}

}  // namespace rook
