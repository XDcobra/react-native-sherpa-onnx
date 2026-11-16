#pragma once

#include <string>

namespace sherpa_onnx {
namespace reader {

/** Version of the normalization + hash below (docs/reader.md, "textHash"). */
inline constexpr int kTextHashVersion = 1;

/**
 * textHash v1 normalization: drop soft hyphen / zero-width characters, unify
 * quotes, dashes and the ellipsis, collapse Unicode whitespace to one space and
 * trim. No case folding, no NFC/NFKC. Invalid UTF-8 bytes become U+FFFD.
 */
std::string NormalizeForHashV1(const std::string& utf8);

/** Lowercase hex of the first 8 bytes of SHA-256 (16 characters). */
std::string ShortSha256Hex(const std::string& bytes);

/** textHash of a text block: ShortSha256Hex(NormalizeForHashV1(text)). */
std::string TextHashV1(const std::string& utf8);

/** textHash of an image block: ShortSha256Hex("\x1Fimage:" + href). */
std::string ImageHashV1(const std::string& href);

/** textHash of a separator block: ShortSha256Hex("\x1Fseparator"). */
std::string SeparatorHashV1();

}  // namespace reader
}  // namespace sherpa_onnx
