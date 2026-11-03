#pragma once

#include <jsi/jsi.h>

#include <cstddef>
#include <cstdint>
#include <vector>

namespace sherpa {

class OwnedBuffer : public facebook::jsi::MutableBuffer {
 public:
  explicit OwnedBuffer(size_t size) : buf_(size) {}

  size_t size() const override { return buf_.size(); }
  uint8_t *data() override { return buf_.data(); }

 private:
  std::vector<uint8_t> buf_;
};

void installJSIBindings(facebook::jsi::Runtime &rt);

}  // namespace sherpa
