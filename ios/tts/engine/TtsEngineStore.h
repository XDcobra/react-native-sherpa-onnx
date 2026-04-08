/**
 * Shared TTS engine instance map and synchronization (single definition site).
 */

#pragma once

#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>

#include "native/sherpa-onnx-tts-wrapper.h"
#include <atomic>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

/**
 * Native PCM sink: holds the last successful batch synthesis result per instance.
 * All reads/writes must be done under g_tts_mutex.
 */
struct BatchPcmSink {
    std::vector<float> samples;
    int32_t sampleRate = 0;
    int32_t numSamples = 0;
    uint64_t generation = 0;

    void update(const std::vector<float> &pcm, int32_t rate) {
        samples = pcm;
        sampleRate = rate;
        numSamples = static_cast<int32_t>(pcm.size());
        ++generation;
    }

    void update(const float *pcm, size_t count, int32_t rate) {
        samples.assign(pcm, pcm + count);
        sampleRate = rate;
        numSamples = static_cast<int32_t>(count);
        ++generation;
    }

    void clear() {
        samples.clear();
        samples.shrink_to_fit();
        sampleRate = 0;
        numSamples = 0;
        // generation stays — stale reads will see mismatch
    }
};

struct TtsInstanceState {
    std::unique_ptr<sherpaonnx::TtsWrapper> wrapper;
    std::atomic<bool> streamRunning{false};
    std::atomic<bool> streamCancelled{false};
    __strong AVAudioEngine *engine = nil;
    __strong AVAudioPlayerNode *player = nil;
    __strong AVAudioFormat *format = nil;
    __strong NSString *modelDir = nil;
    __strong NSString *modelType = nil;
    int32_t numThreads = 2;
    BOOL debug = NO;
    __strong NSNumber *noiseScale = nil;
    __strong NSNumber *noiseScaleW = nil;
    __strong NSNumber *lengthScale = nil;
    __strong NSString *ruleFsts = nil;
    __strong NSString *ruleFars = nil;
    __strong NSNumber *maxNumSentences = nil;
    __strong NSNumber *silenceScale = nil;
    __strong NSString *provider = nil;

    /** PCM sink for the last batch synthesis (Sub-plan 01). */
    BatchPcmSink sink;
};

extern std::unordered_map<std::string, std::shared_ptr<TtsInstanceState>> g_tts_instances;
extern std::mutex g_tts_mutex;
extern std::condition_variable g_tts_stream_cv;
