#pragma once

#include <react/renderer/graphics/Float.h>
#include <react/renderer/graphics/Point.h>

#ifdef RN_SERIALIZABLE_STATE
#include <folly/dynamic.h>
#endif

namespace facebook::react {

/**
 * State of a ReaderView insert host: where the native list currently shows the
 * host, relative to the position Yoga gave it (the reader's top-left).
 *
 * The host's shadow node reports this as its content origin offset, so
 * `measure` (used by Pressability, `measureInWindow`, …) returns on-screen
 * positions for everything inside the insert.
 */
class SherpaReaderInsertState final {
 public:
  SherpaReaderInsertState() = default;
  explicit SherpaReaderInsertState(Point offset) : originOffset(offset) {}

  Point originOffset{};

#ifdef RN_SERIALIZABLE_STATE
  SherpaReaderInsertState(const SherpaReaderInsertState & /*previousState*/, folly::dynamic data)
      : originOffset({(Float)data["x"].getDouble(), (Float)data["y"].getDouble()})
  {
  }

  folly::dynamic getDynamic() const
  {
    return folly::dynamic::object("x", originOffset.x)("y", originOffset.y);
  }
#endif
};

} // namespace facebook::react
