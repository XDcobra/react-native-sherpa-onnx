/**
 * Incremental WAV writer for TTS stream-to-file (PCM16 mono).
 */

#pragma once

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <stdexcept>
#include <string>
#include <vector>

struct StreamingWavSink {
    std::string path;
    int32_t sampleRate = 0;
    int64_t dataBytes = 0;
    std::ofstream out;

    explicit StreamingWavSink(const std::string &p, int32_t sr) : path(p), sampleRate(sr) {
        out.open(path, std::ios::binary | std::ios::trunc);
        if (!out.is_open()) {
            throw std::runtime_error("Failed to open output file");
        }
        char header[44] = {0};
        out.write(header, sizeof(header));
    }

    void writeChunk(const float *samples, int32_t numSamples) {
        if (samples == nullptr || numSamples <= 0) return;
        std::vector<int16_t> pcm(static_cast<size_t>(numSamples));
        for (int32_t i = 0; i < numSamples; ++i) {
            float clamped = std::max(-1.0f, std::min(1.0f, samples[i]));
            pcm[static_cast<size_t>(i)] = static_cast<int16_t>(clamped * 32767.0f);
        }
        out.write(reinterpret_cast<const char *>(pcm.data()), static_cast<std::streamsize>(pcm.size() * sizeof(int16_t)));
        dataBytes += static_cast<int64_t>(pcm.size() * sizeof(int16_t));
    }

    int64_t finalize() {
        out.flush();
        out.close();
        std::fstream f(path, std::ios::binary | std::ios::in | std::ios::out);
        if (!f.is_open()) {
            throw std::runtime_error("Failed to reopen output file for header finalize");
        }
        int32_t channels = 1;
        int32_t bitsPerSample = 16;
        int32_t byteRate = sampleRate * channels * bitsPerSample / 8;
        int32_t blockAlign = channels * bitsPerSample / 8;
        int32_t chunkSize = static_cast<int32_t>(36 + dataBytes);
        int32_t dataSize = static_cast<int32_t>(dataBytes);
        f.seekp(0, std::ios::beg);
        f.write("RIFF", 4);
        f.write(reinterpret_cast<const char *>(&chunkSize), 4);
        f.write("WAVE", 4);
        f.write("fmt ", 4);
        int32_t subchunk1 = 16;
        int16_t audioFormat = 1;
        int16_t ch16 = static_cast<int16_t>(channels);
        int16_t bps16 = static_cast<int16_t>(bitsPerSample);
        int16_t align16 = static_cast<int16_t>(blockAlign);
        f.write(reinterpret_cast<const char *>(&subchunk1), 4);
        f.write(reinterpret_cast<const char *>(&audioFormat), 2);
        f.write(reinterpret_cast<const char *>(&ch16), 2);
        f.write(reinterpret_cast<const char *>(&sampleRate), 4);
        f.write(reinterpret_cast<const char *>(&byteRate), 4);
        f.write(reinterpret_cast<const char *>(&align16), 2);
        f.write(reinterpret_cast<const char *>(&bps16), 2);
        f.write("data", 4);
        f.write(reinterpret_cast<const char *>(&dataSize), 4);
        f.close();
        return dataBytes;
    }

    void abort(bool deleteFile) {
        if (out.is_open()) {
            out.flush();
            out.close();
        }
        if (deleteFile) {
            std::remove(path.c_str());
        }
    }
};
