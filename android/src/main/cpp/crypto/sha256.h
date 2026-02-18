#pragma once

#include <cstddef>
#include <cstdint>

// Minimal SHA-256 implementation for Android builds (no external deps).
struct Sha256Context {
  uint64_t total_bits = 0;
  uint32_t state[8] = {};
  uint8_t buffer[64] = {};
  size_t buffer_size = 0;
};

void sha256_init(Sha256Context* ctx);
void sha256_update(Sha256Context* ctx, const uint8_t* data, size_t len);
void sha256_final(Sha256Context* ctx, uint8_t out[32]);
