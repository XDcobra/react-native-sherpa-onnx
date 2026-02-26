/**
 * sha256.cpp
 *
 * Purpose: SHA-256 implementation for file hashing. Used by the archive helper (Android) for
 * integrity verification of extracted model archives.
 */
#include "crypto/sha256.h"

#include <cstring>

namespace {
constexpr uint32_t kInitState[8] = {
    0x6a09e667u,
    0xbb67ae85u,
    0x3c6ef372u,
    0xa54ff53au,
    0x510e527fu,
    0x9b05688cu,
    0x1f83d9abu,
    0x5be0cd19u,
};

constexpr uint32_t kRoundConstants[64] = {
    0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu,
    0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u, 0xd807aa98u, 0x12835b01u,
    0x243185beu, 0x550c7dc3u, 0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u,
    0xc19bf174u, 0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu,
    0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau, 0x983e5152u,
    0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u,
    0x06ca6351u, 0x14292967u, 0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu,
    0x53380d13u, 0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
    0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u, 0xd192e819u,
    0xd6990624u, 0xf40e3585u, 0x106aa070u, 0x19a4c116u, 0x1e376c08u,
    0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu,
    0x682e6ff3u, 0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u,
    0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u,
};

inline uint32_t rotr(uint32_t value, uint32_t bits) {
  return (value >> bits) | (value << (32 - bits));
}

inline uint32_t ch(uint32_t x, uint32_t y, uint32_t z) {
  return (x & y) ^ (~x & z);
}

inline uint32_t maj(uint32_t x, uint32_t y, uint32_t z) {
  return (x & y) ^ (x & z) ^ (y & z);
}

inline uint32_t big_sigma0(uint32_t x) {
  return rotr(x, 2) ^ rotr(x, 13) ^ rotr(x, 22);
}

inline uint32_t big_sigma1(uint32_t x) {
  return rotr(x, 6) ^ rotr(x, 11) ^ rotr(x, 25);
}

inline uint32_t small_sigma0(uint32_t x) {
  return rotr(x, 7) ^ rotr(x, 18) ^ (x >> 3);
}

inline uint32_t small_sigma1(uint32_t x) {
  return rotr(x, 17) ^ rotr(x, 19) ^ (x >> 10);
}

void process_block(Sha256Context* ctx, const uint8_t block[64]) {
  uint32_t w[64];
  for (int i = 0; i < 16; ++i) {
    int idx = i * 4;
    w[i] = (static_cast<uint32_t>(block[idx]) << 24) |
           (static_cast<uint32_t>(block[idx + 1]) << 16) |
           (static_cast<uint32_t>(block[idx + 2]) << 8) |
           (static_cast<uint32_t>(block[idx + 3]));
  }
  for (int i = 16; i < 64; ++i) {
    w[i] = small_sigma1(w[i - 2]) + w[i - 7] + small_sigma0(w[i - 15]) + w[i - 16];
  }

  uint32_t a = ctx->state[0];
  uint32_t b = ctx->state[1];
  uint32_t c = ctx->state[2];
  uint32_t d = ctx->state[3];
  uint32_t e = ctx->state[4];
  uint32_t f = ctx->state[5];
  uint32_t g = ctx->state[6];
  uint32_t h = ctx->state[7];

  for (int i = 0; i < 64; ++i) {
    uint32_t t1 = h + big_sigma1(e) + ch(e, f, g) + kRoundConstants[i] + w[i];
    uint32_t t2 = big_sigma0(a) + maj(a, b, c);
    h = g;
    g = f;
    f = e;
    e = d + t1;
    d = c;
    c = b;
    b = a;
    a = t1 + t2;
  }

  ctx->state[0] += a;
  ctx->state[1] += b;
  ctx->state[2] += c;
  ctx->state[3] += d;
  ctx->state[4] += e;
  ctx->state[5] += f;
  ctx->state[6] += g;
  ctx->state[7] += h;
}
}  // namespace

void sha256_init(Sha256Context* ctx) {
  ctx->total_bits = 0;
  ctx->buffer_size = 0;
  std::memcpy(ctx->state, kInitState, sizeof(kInitState));
}

void sha256_update(Sha256Context* ctx, const uint8_t* data, size_t len) {
  if (len == 0) {
    return;
  }

  ctx->total_bits += static_cast<uint64_t>(len) * 8u;
  size_t offset = 0;

  if (ctx->buffer_size > 0) {
    size_t to_copy = 64 - ctx->buffer_size;
    if (to_copy > len) {
      to_copy = len;
    }
    std::memcpy(ctx->buffer + ctx->buffer_size, data, to_copy);
    ctx->buffer_size += to_copy;
    offset += to_copy;
    if (ctx->buffer_size == 64) {
      process_block(ctx, ctx->buffer);
      ctx->buffer_size = 0;
    }
  }

  while (offset + 64 <= len) {
    process_block(ctx, data + offset);
    offset += 64;
  }

  if (offset < len) {
    ctx->buffer_size = len - offset;
    std::memcpy(ctx->buffer, data + offset, ctx->buffer_size);
  }
}

void sha256_final(Sha256Context* ctx, uint8_t out[32]) {
  uint64_t message_bits = ctx->total_bits;
  uint8_t padding[64] = {};
  padding[0] = 0x80;

  size_t pad_len = (ctx->buffer_size < 56) ? (56 - ctx->buffer_size) : (120 - ctx->buffer_size);
  sha256_update(ctx, padding, pad_len);

  uint8_t length_bytes[8];
  uint64_t total_bits = message_bits;
  for (int i = 7; i >= 0; --i) {
    length_bytes[i] = static_cast<uint8_t>(total_bits & 0xFFu);
    total_bits >>= 8;
  }
  sha256_update(ctx, length_bytes, 8);

  for (int i = 0; i < 8; ++i) {
    out[i * 4] = static_cast<uint8_t>((ctx->state[i] >> 24) & 0xFFu);
    out[i * 4 + 1] = static_cast<uint8_t>((ctx->state[i] >> 16) & 0xFFu);
    out[i * 4 + 2] = static_cast<uint8_t>((ctx->state[i] >> 8) & 0xFFu);
    out[i * 4 + 3] = static_cast<uint8_t>(ctx->state[i] & 0xFFu);
  }
}
