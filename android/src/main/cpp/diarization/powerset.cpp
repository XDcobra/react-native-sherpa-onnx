#include "powerset.h"

#include <algorithm>
#include <cmath>
#include <numeric>

namespace sherpaonnx::diarization {
namespace {

int32_t Binomial(int32_t n, int32_t k) {
  if (k < 0 || k > n) {
    return 0;
  }
  if (k == 0 || k == n) {
    return 1;
  }
  if (k > n - k) {
    k = n - k;
  }
  int64_t result = 1;
  for (int32_t i = 1; i <= k; ++i) {
    result = result * (n - k + i) / i;
  }
  return static_cast<int32_t>(result);
}

void AppendCombinations(int32_t num_speakers, int32_t k,
                        std::vector<int8_t>* mapping, int32_t* class_index) {
  std::vector<int32_t> combo(static_cast<size_t>(k));
  std::iota(combo.begin(), combo.end(), 0);

  while (true) {
    int8_t* row =
        mapping->data() +
        static_cast<size_t>(*class_index) * static_cast<size_t>(num_speakers);
    std::fill(row, row + num_speakers, static_cast<int8_t>(0));
    for (int32_t idx : combo) {
      row[idx] = 1;
    }
    ++(*class_index);

    int32_t i = k - 1;
    while (i >= 0 && combo[static_cast<size_t>(i)] == num_speakers - k + i) {
      --i;
    }
    if (i < 0) {
      break;
    }
    ++combo[static_cast<size_t>(i)];
    for (int32_t j = i + 1; j < k; ++j) {
      combo[static_cast<size_t>(j)] = combo[static_cast<size_t>(j - 1)] + 1;
    }
  }
}

}  // namespace

int32_t PowersetDecoder::ExpectedNumClasses(int32_t num_speakers,
                                            int32_t powerset_max_classes) {
  if (num_speakers <= 0 || powerset_max_classes < 0) {
    return -1;
  }
  int32_t total = 1;  // empty set
  const int32_t max_k = std::min(powerset_max_classes, num_speakers);
  for (int32_t k = 1; k <= max_k; ++k) {
    total += Binomial(num_speakers, k);
  }
  return total;
}

Status PowersetDecoder::Init(int32_t num_speakers, int32_t powerset_max_classes,
                             int32_t expected_num_classes) {
  if (num_speakers <= 0) {
    return Status::Fail(kErrInvalidArgument, "num_speakers must be > 0");
  }
  if (powerset_max_classes < 0) {
    return Status::Fail(kErrInvalidArgument,
                        "powerset_max_classes must be >= 0");
  }
  if (powerset_max_classes > num_speakers) {
    return Status::Fail(
        kErrMetadata,
        "powerset_max_classes exceeds num_speakers");
  }

  const int32_t computed =
      ExpectedNumClasses(num_speakers, powerset_max_classes);
  if (computed <= 0) {
    return Status::Fail(kErrInternal, "failed to compute powerset size");
  }
  if (expected_num_classes > 0 && expected_num_classes != computed) {
    return Status::Fail(
        kErrMetadata,
        "num_classes metadata (" + std::to_string(expected_num_classes) +
            ") does not match powerset expansion (" +
            std::to_string(computed) + ")");
  }

  num_speakers_ = num_speakers;
  powerset_max_classes_ = powerset_max_classes;
  num_classes_ = computed;
  mapping_.assign(static_cast<size_t>(num_classes_) *
                      static_cast<size_t>(num_speakers_),
                  static_cast<int8_t>(0));

  // Class 0 = empty set (already zero-filled).
  int32_t class_index = 1;
  for (int32_t k = 1; k <= powerset_max_classes_; ++k) {
    AppendCombinations(num_speakers_, k, &mapping_, &class_index);
  }
  if (class_index != num_classes_) {
    return Status::Fail(kErrInternal, "powerset mapping size mismatch");
  }
  return Status::Ok();
}

Int8Matrix PowersetDecoder::Decode(const float* logits, int32_t num_frames,
                                   int32_t num_classes) const {
  Int8Matrix out;
  if (logits == nullptr || num_frames <= 0 || num_classes != num_classes_ ||
      num_speakers_ <= 0) {
    return out;
  }
  out.resize(num_frames, num_speakers_, 0);
  for (int32_t f = 0; f < num_frames; ++f) {
    const float* row = logits + static_cast<size_t>(f) *
                                    static_cast<size_t>(num_classes);
    // Deterministic tie-break: lowest class index wins.
    int32_t best = 0;
    float best_val = row[0];
    for (int32_t c = 1; c < num_classes; ++c) {
      if (row[c] > best_val) {
        best_val = row[c];
        best = c;
      }
    }
    const int8_t* map_row =
        mapping_.data() +
        static_cast<size_t>(best) * static_cast<size_t>(num_speakers_);
    for (int32_t s = 0; s < num_speakers_; ++s) {
      out.at(f, s) = map_row[s];
    }
  }
  return out;
}

}  // namespace sherpaonnx::diarization
