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
};

extern std::unordered_map<std::string, std::shared_ptr<TtsInstanceState>> g_tts_instances;
extern std::mutex g_tts_mutex;
extern std::condition_variable g_tts_stream_cv;
