/**
 * SherpaOnnx+TextBuffer.mm
 *
 * Unified pipeline text buffer registry for iOS.
 * Mirrors the Kotlin TextPipelineRegistry with two buffer kinds:
 * - OfflineTextEntry: immutable text (STT result, imported text)
 * - LiveTextEntry: streaming text with partial updates, recording/finished state machine
 *
 * Implements all TurboModule methods for text buffer lifecycle, getters, and release.
 */

#import "../../SherpaOnnx.h"
#include "TextRegistry.h"
#include "TxtJetsamCaps.h"
#include "TxtMetaBridge.h"
#import <React/RCTLog.h>
#include <mutex>
#include <unordered_map>
#include <vector>
#include <string>
#include <atomic>
#include <deque>
#include <algorithm>
#include <stdexcept>
#include <chrono>

// ==================== Error Codes ====================
static NSString *const kTxtErrBufferNotFound   = @"TEXT_BUFFER_NOT_FOUND";
static NSString *const kTxtErrKindMismatch     = @"TEXT_BUFFER_KIND_MISMATCH";
static NSString *const kTxtErrInvalidArgument  = @"TEXT_INVALID_ARGUMENT";
static NSString *const kTxtErrInvalidState     = @"TEXT_INVALID_STATE";
static NSString *const kTxtErrBufferEmpty      = @"TEXT_BUFFER_EMPTY";
static NSString *const kTxtErrAlreadyFinalized = @"TEXT_ALREADY_FINALIZED";
static NSString *const kTxtErrAlreadyPopulated = @"TEXT_ALREADY_POPULATED";
static NSString *const kTxtErrSliceInvalid     = @"TEXT_SLICE_INVALID";
static NSString *const kTxtErrSliceTooLarge    = @"TEXT_SLICE_TOO_LARGE";
static NSString *const kTxtErrSpoolUnavailable = @"TEXT_SPOOL_UNAVAILABLE";
static NSString *const kTxtErrSpoolWriteFailed = @"TEXT_SPOOL_WRITE_FAILED";
static NSString *const kTxtErrSpoolReadFailed  = @"TEXT_SPOOL_READ_FAILED";
static NSString *const kTxtErrSpoolCorrupted   = @"TEXT_SPOOL_CORRUPTED";
static NSString *const kTxtErrInternalError    = @"TEXT_INTERNAL_ERROR";

static const int kTxtMaxSliceCount = 16384;

static NSDictionary<NSString *, NSString *> *txtCodedErrorsMap() {
    static NSDictionary<NSString *, NSString *> *map;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        map = @{
            kTxtErrBufferNotFound: kTxtErrBufferNotFound,
            kTxtErrKindMismatch: kTxtErrKindMismatch,
            kTxtErrInvalidArgument: kTxtErrInvalidArgument,
            kTxtErrInvalidState: kTxtErrInvalidState,
            kTxtErrBufferEmpty: kTxtErrBufferEmpty,
            kTxtErrAlreadyFinalized: kTxtErrAlreadyFinalized,
            kTxtErrAlreadyPopulated: kTxtErrAlreadyPopulated,
            kTxtErrSliceInvalid: kTxtErrSliceInvalid,
            kTxtErrSliceTooLarge: kTxtErrSliceTooLarge,
            kTxtErrSpoolUnavailable: kTxtErrSpoolUnavailable,
            kTxtErrSpoolWriteFailed: kTxtErrSpoolWriteFailed,
            kTxtErrSpoolReadFailed: kTxtErrSpoolReadFailed,
            kTxtErrSpoolCorrupted: kTxtErrSpoolCorrupted,
            kTxtErrInternalError: kTxtErrInternalError,
        };
    });
    return map;
}

static void txtRejectWithStdException(RCTPromiseRejectBlock reject, const std::exception &e) {
    std::string raw = e.what() ? e.what() : "";
    size_t sep = raw.find(':');
    if (sep != std::string::npos) {
        std::string codeRaw = raw.substr(0, sep);
        std::string messageRaw = raw.substr(sep + 1);
        while (!messageRaw.empty() && messageRaw.front() == ' ') {
            messageRaw.erase(messageRaw.begin());
        }
        NSString *code = [NSString stringWithUTF8String:codeRaw.c_str()] ?: kTxtErrInternalError;
        NSString *message = [NSString stringWithUTF8String:messageRaw.c_str()] ?: @"Unknown text buffer error";
        if (txtCodedErrorsMap()[code] != nil) {
            reject(code, message, nil);
            return;
        }
    }
    reject(kTxtErrInternalError, [NSString stringWithUTF8String:raw.c_str()] ?: @"Unknown text buffer error", nil);
}


// ==================== RN helpers (SoT lives in TextRegistry / Txt*) ====================

static NSDictionary *txtSpatialSpanToDict(const TxtSpatialSpan &span) {
    NSMutableArray *quad = [NSMutableArray arrayWithCapacity:8];
    for (int i = 0; i < 8; i++) {
        [quad addObject:@(span.quad[i])];
    }
    NSMutableDictionary *map = [@{
        @"utf16Start": @(span.utf16Start),
        @"utf16End": @(span.utf16End),
        @"level": [NSString stringWithUTF8String:span.level.c_str()] ?: @"line",
        @"sourceImageBufferId":
            [NSString stringWithUTF8String:span.sourceImageBufferId.c_str()] ?: @"",
        @"frameIndex": @(span.frameIndex),
        @"quad": quad,
        @"origin": [NSString stringWithUTF8String:span.origin.c_str()] ?: @"ocr",
    } mutableCopy];
    if (span.hasConfidence) map[@"confidence"] = @(span.confidence);
    if (span.hasPageNumber) map[@"pageNumber"] = @(span.pageNumber);
    if (span.hasPtsMs) map[@"ptsMs"] = @(span.ptsMs);
    if (span.hasPageWidth) map[@"pageWidth"] = @(span.pageWidth);
    if (span.hasPageHeight) map[@"pageHeight"] = @(span.pageHeight);
    if (span.hasSectionIndex) map[@"sectionIndex"] = @(span.sectionIndex);
    if (!span.href.empty()) {
        map[@"href"] = [NSString stringWithUTF8String:span.href.c_str()] ?: @"";
    }
    return map;
}

static NSDictionary *txtOfflineToDict(const TxtOfflineEntry &entry) {
    return @{
        @"bufferId": [NSString stringWithUTF8String:entry.bufferId.c_str()],
        @"kind": @"offlineTextBuffer",
        @"state": @"immutable",
        @"utf16Length": @(entry.utf16Length()),
        @"tokenCount": @(entry.tokenCount()),
        @"timestampCount": @(entry.timestampCount()),
        @"durationCount": @(entry.durationCount()),
        @"spatialSpanCount": @(entry.spatialSpanCount()),
        @"hasLang": @(entry.hasLang()),
        @"hasEmotion": @(entry.hasEmotion()),
        @"hasEvent": @(entry.hasEvent()),
        @"hasSpatialSpans": @(entry.hasSpatialSpans()),
    };
}

static NSDictionary *txtLiveToDict(TxtLiveEntry &entry) {
    std::string stateValue;
    int64_t totalChars = 0;
    bool enabled = false;
    {
        std::lock_guard<std::mutex> lock(entry.stateMutex);
        stateValue = entry.state == TxtLiveEntry::RECORDING ? "recording" : "finished";
        totalChars = entry.totalCharsWritten;
        enabled = entry.spoolEnabled();
    }
    std::string spoolModeRaw;
    bool ready = false;
    int64_t bytes = 0;
    std::string path;
    {
        std::lock_guard<std::mutex> lock(entry.spoolMutex);
        spoolModeRaw = TxtLiveEntry::spoolingModeRaw(entry.spoolingMode);
        ready = entry.spoolReady;
        bytes = entry.spoolBytes;
        path = entry.spoolPath;
    }
    NSMutableDictionary *dict = [@{
        @"bufferId": [NSString stringWithUTF8String:entry.bufferId.c_str()],
        @"kind": @"liveTextBuffer",
        @"state": [NSString stringWithUTF8String:stateValue.c_str()],
        @"totalCharsWritten": @(totalChars),
        @"revision": @(entry.revision.load()),
        @"segmentCount": @(entry.segmentCount()),
        @"spoolMode": [NSString stringWithUTF8String:spoolModeRaw.c_str()],
        @"spoolEnabled": @(enabled),
        @"spoolReady": @(ready),
        @"spoolBytes": @(bytes),
    } mutableCopy];
    if (!path.empty()) {
        dict[@"spoolPath"] = [NSString stringWithUTF8String:path.c_str()];
    }
    return dict;
}

static std::unordered_map<std::string, int64_t> g_txt_partial_last_emit_ms;
static std::mutex g_txt_partial_emit_mutex;
static __weak SherpaOnnx *g_txt_partial_event_module = nil;

static int64_t txt_now_ms() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

extern "C" void txt_set_partial_event_module(SherpaOnnx *module) {
    g_txt_partial_event_module = module;
}

static void txt_ios_partial_emit(
    const std::string &bufferId,
    const char *source,
    int utf16Length,
    int64_t revisionValue,
    int64_t partialEventMinIntervalMs
) {
    {
        std::lock_guard<std::mutex> emitLock(g_txt_partial_emit_mutex);
        int64_t nowMs = txt_now_ms();
        auto found = g_txt_partial_last_emit_ms.find(bufferId);
        if (found != g_txt_partial_last_emit_ms.end()) {
            if (partialEventMinIntervalMs > 0 &&
                (nowMs - found->second) < partialEventMinIntervalMs) {
                return;
            }
        }
        g_txt_partial_last_emit_ms[bufferId] = nowMs;
    }
    SherpaOnnx *bridge = g_txt_partial_event_module;
    if (bridge == nil) return;
    NSString *bid = [NSString stringWithUTF8String:bufferId.c_str()];
    NSString *src = source ? [NSString stringWithUTF8String:source] : @"unknown";
    dispatch_async(dispatch_get_main_queue(), ^{
        [bridge sendEventWithName:@"pipelineLiveTextPartial" body:@{
            @"liveBufferId": bid ?: @"",
            @"source": src ?: @"unknown",
            @"utf16Length": @(utf16Length),
            @"revision": @(revisionValue),
        }];
    });
}

__attribute__((constructor))
static void txt_register_partial_emit() {
    txt_set_partial_emit_fn(&txt_ios_partial_emit);
}

static std::string txt_bridge_generate_id(const char *prefix) {
    return std::string(prefix) + "_" + [[[NSUUID UUID] UUIDString] UTF8String];
}

static void txt_emit_live_text_segment_event(
    SherpaOnnx *module,
    NSString *liveBufferId,
    const TextSegment &segment,
    int totalSegments
) {
    if (module == nil) return;

    NSMutableDictionary *body = [NSMutableDictionary dictionary];
    body[@"liveBufferId"] = liveBufferId ?: @"";
    body[@"totalSegments"] = @(totalSegments);
    body[@"source"] = [NSString stringWithUTF8String:segment.source.c_str()] ?: @"unknown";
    body[@"segmentIndex"] = @(segment.segmentIndex);
    body[@"utf16Length"] = @(txt_utf16_length(segment.text));

    dispatch_async(dispatch_get_main_queue(), ^{
        [module sendEventWithName:@"pipelineLiveTextSegmentAppended" body:body];
    });
}

// ==================== TurboModule Methods ====================

@implementation SherpaOnnx (TextBuffer)

- (void)createEmptyOfflineTextBuffer:(RCTPromiseResolveBlock)resolve
                              reject:(RCTPromiseRejectBlock)reject
{
    @try {
        std::string bufferId = txt_bridge_generate_id("txt_off");
        auto entry = std::make_shared<TxtOfflineEntry>();
        entry->bufferId = bufferId;
        {
            std::lock_guard<std::mutex> lock(g_txt_mutex);
            g_txt_offline[bufferId] = entry;
        }
        resolve(txtOfflineToDict(*entry));
    } @catch (NSException *exception) {
        reject(kTxtErrInternalError, exception.reason, nil);
    }
}

- (void)createOfflineTextBufferFromLive:(NSString *)liveBufferId
                                   mode:(NSString *)mode
                                resolve:(RCTPromiseResolveBlock)resolve
                                 reject:(RCTPromiseRejectBlock)reject
{
    try {
        std::string liveId = [liveBufferId UTF8String] ?: "";
        std::string modeStr = mode ? [mode UTF8String] : "fullIfSpooled";

        std::shared_ptr<TxtLiveEntry> live;
        {
            std::lock_guard<std::mutex> lock(g_txt_mutex);
            auto it = g_txt_live.find(liveId);
            if (it == g_txt_live.end()) {
                reject(kTxtErrBufferNotFound,
                       [NSString stringWithFormat:@"Live text buffer not found: %@", liveBufferId], nil);
                return;
            }
            live = it->second;
        }

        std::string text;
        if (modeStr == "windowSnapshot") {
            text = live->snapshotText();
        } else if (modeStr == "fullIfSpooled") {
            text = live->snapshotFullTextIfSpooled();
        } else {
            reject(kTxtErrInvalidArgument,
                   [NSString stringWithFormat:@"Unknown mode: %s. Use 'fullIfSpooled' or 'windowSnapshot'.", modeStr.c_str()],
                   nil);
            return;
        }

        std::string bufferId = txt_bridge_generate_id("txt_off");
        auto entry = std::make_shared<TxtOfflineEntry>();
        entry->bufferId = bufferId;
        if (!text.empty()) {
            entry->text = text;
            entry->populated = true;
        }
        {
            std::lock_guard<std::mutex> lock(g_txt_mutex);
            g_txt_offline[bufferId] = entry;
        }
        resolve(txtOfflineToDict(*entry));
    } catch (const std::exception &e) {
        txtRejectWithStdException(reject, e);
    } catch (...) {
        reject(kTxtErrInternalError, @"Unknown createOfflineTextBufferFromLive error", nil);
    }
}

- (void)createOfflineTextBufferFromText:(NSString *)text
                                options:(NSDictionary *)options
                                resolve:(RCTPromiseResolveBlock)resolve
                                 reject:(RCTPromiseRejectBlock)reject
{
    @try {
        if (text == nil) {
            reject(kTxtErrInvalidArgument, @"text is required", nil);
            return;
        }
        std::string bufferId = txt_bridge_generate_id("txt_off");
        auto entry = std::make_shared<TxtOfflineEntry>();
        entry->bufferId = bufferId;
        entry->text = [text UTF8String];
        entry->populated = true;
        if (options != nil) {
            if ([options[@"lang"] isKindOfClass:[NSString class]]) {
                entry->lang = [options[@"lang"] UTF8String];
            }
            if ([options[@"emotion"] isKindOfClass:[NSString class]]) {
                entry->emotion = [options[@"emotion"] UTF8String];
            }
            if ([options[@"event"] isKindOfClass:[NSString class]]) {
                entry->event = [options[@"event"] UTF8String];
            }
        }
        {
            std::lock_guard<std::mutex> lock(g_txt_mutex);
            g_txt_offline[bufferId] = entry;
        }
        resolve(txtOfflineToDict(*entry));
    } @catch (NSException *exception) {
        reject(kTxtErrInternalError, exception.reason, nil);
    }
}

- (void)populateOfflineTextBufferIfEmpty:(NSString *)bufferId
                                    text:(NSString *)text
                                 options:(NSDictionary *)options
                                 resolve:(RCTPromiseResolveBlock)resolve
                                  reject:(RCTPromiseRejectBlock)reject
{
    @try {
        if (bufferId == nil || [bufferId length] == 0) {
            reject(kTxtErrInvalidArgument, @"bufferId is required", nil);
            return;
        }

        const std::string bid = [bufferId UTF8String] ?: "";
        const std::string t = text != nil ? ([text UTF8String] ?: "") : "";
        std::string lang;
        std::string emotion;
        std::string event;
        if (options != nil) {
            if ([options[@"lang"] isKindOfClass:[NSString class]]) {
                lang = [options[@"lang"] UTF8String] ?: "";
            }
            if ([options[@"emotion"] isKindOfClass:[NSString class]]) {
                emotion = [options[@"emotion"] UTF8String] ?: "";
            }
            if ([options[@"event"] isKindOfClass:[NSString class]]) {
                event = [options[@"event"] UTF8String] ?: "";
            }
        }

        std::string error;
        if (!txt_populate_offline_if_empty(
              bid,
              t,
              {},
              {},
              {},
              lang,
              emotion,
              event,
              &error
            )) {
            NSString *message = [NSString stringWithUTF8String:error.c_str()] ?: @"Failed to populate offline text buffer";
            if (error.find("not found") != std::string::npos) {
                reject(kTxtErrBufferNotFound, message, nil);
                return;
            }
            if (error.find("already populated") != std::string::npos) {
                reject(kTxtErrAlreadyPopulated, message, nil);
                return;
            }
            reject(kTxtErrInternalError, message, nil);
            return;
        }

        resolve(nil);
    } @catch (NSException *exception) {
        reject(kTxtErrInternalError, exception.reason, nil);
    }
}

- (void)createLiveTextBuffer:(JS::NativeSherpaOnnx::SpecCreateLiveTextBufferOptions &)options
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject
{
    try {
        int windowMaxChars = 65536;
        int maxSegments = 4096;
        bool emitPartialEvents = false;
        int64_t partialEventMinIntervalMs = 0;
        TxtLiveEntry::SpoolingMode spoolingMode = TxtLiveEntry::SPOOL_ON;
        int64_t spoolingThresholdBytes = 0;
        std::string spoolingPath;
        bool spoolingTemporary = true;

        if (auto windowMaxCharsOpt = options.windowMaxChars()) {
            windowMaxChars = static_cast<int>(windowMaxCharsOpt.value());
        }
        if (auto maxSegmentsOpt = options.maxSegments()) {
            maxSegments = static_cast<int>(maxSegmentsOpt.value());
        }
        // Adaptive Jetsam clamp (TextBuffer only; ForceTight = harness).
        // Perf keep: docs/internal/textbuffer/performance/textbuffer-perf-plan.md (D-I3).
        (void)txt_ios_apply_jetsam_caps(&windowMaxChars, &maxSegments);
        if (auto emitPartialEventsOpt = options.emitPartialEvents()) {
            emitPartialEvents = emitPartialEventsOpt.value();
        }
        if (auto partialEventMinIntervalMsOpt = options.partialEventMinIntervalMs()) {
            partialEventMinIntervalMs = static_cast<int64_t>(partialEventMinIntervalMsOpt.value());
        }
        if (NSString *rawMode = options.spoolingMode()) {
            if ([rawMode isEqualToString:@"off"]) {
                spoolingMode = TxtLiveEntry::SPOOL_OFF;
            } else if ([rawMode isEqualToString:@"auto"]) {
                spoolingMode = TxtLiveEntry::SPOOL_AUTO;
            } else if ([rawMode isEqualToString:@"on"] || rawMode.length == 0) {
                spoolingMode = TxtLiveEntry::SPOOL_ON;
            } else {
                reject(kTxtErrInvalidArgument,
                       [NSString stringWithFormat:@"Invalid text spooling mode: %@. Use 'off', 'auto', or 'on'.", rawMode],
                       nil);
                return;
            }
        }
        if (auto spoolingThresholdBytesOpt = options.spoolingThresholdBytes()) {
            spoolingThresholdBytes = static_cast<int64_t>(spoolingThresholdBytesOpt.value());
        }
        if (NSString *path = options.spoolingPath()) {
            if (path.length > 0) {
                spoolingPath = [path UTF8String] ?: "";
            }
        }
        if (auto spoolingTemporaryOpt = options.spoolingTemporary()) {
            spoolingTemporary = spoolingTemporaryOpt.value();
        } else {
            spoolingTemporary = spoolingPath.empty();
        }

        if (spoolingMode != TxtLiveEntry::SPOOL_OFF && spoolingPath.empty()) {
            NSString *tmpDir = NSTemporaryDirectory();
            if (tmpDir == nil || tmpDir.length == 0) tmpDir = @"/tmp";
            NSString *fileName = [NSString stringWithFormat:@"txt_spool_%@.bin", [[NSUUID UUID] UUIDString]];
            NSString *joined = [tmpDir stringByAppendingPathComponent:fileName];
            spoolingPath = [joined UTF8String] ?: "";
        }

        std::string bufferId = txt_bridge_generate_id("txt_live");
        auto entry = std::make_shared<TxtLiveEntry>();
        entry->bufferId = bufferId;
        entry->windowMaxChars = windowMaxChars;
        entry->maxSegments = maxSegments;
        entry->emitPartialEvents = emitPartialEvents;
        entry->partialEventMinIntervalMs = partialEventMinIntervalMs;
        entry->configureSpooling(spoolingMode, spoolingPath, spoolingTemporary, spoolingThresholdBytes);
        __weak SherpaOnnx *weakSelf = self;
        std::weak_ptr<TxtLiveEntry> weakEntry = entry;
        NSString *liveBufferId = [NSString stringWithUTF8String:bufferId.c_str()] ?: @"";
        entry->addCommitListener([weakSelf, weakEntry, liveBufferId](const TextSegment &segment) {
            SherpaOnnx *strongSelf = weakSelf;
            if (strongSelf == nil) return;
            int totalSegments = segment.segmentIndex + 1;
            if (auto strongEntry = weakEntry.lock()) {
                totalSegments = strongEntry->segmentCount();
            }
            txt_emit_live_text_segment_event(strongSelf, liveBufferId, segment, totalSegments);
        });
        {
            std::lock_guard<std::mutex> lock(g_txt_mutex);
            g_txt_live[bufferId] = entry;
        }
        resolve(txtLiveToDict(*entry));
    } catch (const std::exception &e) {
        txtRejectWithStdException(reject, e);
    } catch (...) {
        reject(kTxtErrInternalError, @"Unknown createLiveTextBuffer error", nil);
    }
}

- (void)createLiveTextBufferFromOffline:(NSString *)offlineBufferId
                                 resolve:(RCTPromiseResolveBlock)resolve
                                  reject:(RCTPromiseRejectBlock)reject
{
    try {
        std::string offId = [offlineBufferId UTF8String] ?: "";
        NSString *tmpDir = NSTemporaryDirectory();
        if (tmpDir == nil || tmpDir.length == 0) tmpDir = @"/tmp";
        NSString *fileName = [NSString stringWithFormat:@"txt_spool_%@.bin", [[NSUUID UUID] UUIDString]];
        NSString *joined = [tmpDir stringByAppendingPathComponent:fileName];
        std::string spoolPath = [joined UTF8String] ?: "";

        std::string bufferId;
        std::string errCode;
        std::string errMsg;
        if (!txt_create_live_from_offline(offId, 65536, 4096, false, 0, "on", spoolPath, true,
                                          &bufferId, &errCode, &errMsg)) {
            NSString *msg = errMsg.empty()
                ? [NSString stringWithFormat:@"Offline text buffer not found: %@", offlineBufferId]
                : [NSString stringWithUTF8String:errMsg.c_str()];
            reject(kTxtErrBufferNotFound, msg, nil);
            return;
        }

        auto entry = txt_get_live_entry(bufferId);
        if (!entry) {
            reject(kTxtErrInternalError, @"Live text buffer missing after createLiveFromOffline", nil);
            return;
        }
        __weak SherpaOnnx *weakSelf = self;
        std::weak_ptr<TxtLiveEntry> weakEntry = entry;
        NSString *liveBufferId = [NSString stringWithUTF8String:bufferId.c_str()] ?: @"";
        entry->addCommitListener([weakSelf, weakEntry, liveBufferId](const TextSegment &segment) {
            SherpaOnnx *strongSelf = weakSelf;
            if (strongSelf == nil) return;
            int totalSegments = segment.segmentIndex + 1;
            if (auto strongEntry = weakEntry.lock()) {
                totalSegments = strongEntry->segmentCount();
            }
            txt_emit_live_text_segment_event(strongSelf, liveBufferId, segment, totalSegments);
        });
        resolve(txtLiveToDict(*entry));
    } catch (const std::exception &e) {
        txtRejectWithStdException(reject, e);
    } catch (...) {
        reject(kTxtErrInternalError, @"Unknown createLiveTextBufferFromOffline error", nil);
    }
}

- (void)finalizeLiveTextBuffer:(NSString *)liveBufferId
                        resolve:(RCTPromiseResolveBlock)resolve
                         reject:(RCTPromiseRejectBlock)reject
{
    try {
        std::string liveId = [liveBufferId UTF8String] ?: "";
        std::shared_ptr<TxtLiveEntry> entry;

        {
            std::lock_guard<std::mutex> lock(g_txt_mutex);
            auto it = g_txt_live.find(liveId);
            if (it == g_txt_live.end()) {
                reject(kTxtErrBufferNotFound,
                       [NSString stringWithFormat:@"Live text buffer not found: %@", liveBufferId], nil);
                return;
            }
            entry = it->second;
        }

        if (entry->state == TxtLiveEntry::FINISHED) {
            reject(kTxtErrAlreadyFinalized, @"Live text buffer already finalized", nil);
            return;
        }
        entry->finalize_();
        resolve(nil);
    } catch (const std::exception &e) {
        txtRejectWithStdException(reject, e);
    } catch (...) {
        reject(kTxtErrInternalError, @"Unknown finalizeLiveTextBuffer error", nil);
    }
}

- (void)getPipelineTextBufferInfo:(NSString *)bufferId
                           resolve:(RCTPromiseResolveBlock)resolve
                            reject:(RCTPromiseRejectBlock)reject
{
    @try {
        std::string bid = [bufferId UTF8String] ?: "";

        std::lock_guard<std::mutex> lock(g_txt_mutex);
        auto offIt = g_txt_offline.find(bid);
        if (offIt != g_txt_offline.end()) {
            resolve(txtOfflineToDict(*offIt->second));
            return;
        }
        auto liveIt = g_txt_live.find(bid);
        if (liveIt != g_txt_live.end()) {
            resolve(txtLiveToDict(*liveIt->second));
            return;
        }
        reject(kTxtErrBufferNotFound,
               [NSString stringWithFormat:@"Text buffer not found: %@", bufferId], nil);
    } @catch (NSException *exception) {
        reject(kTxtErrInternalError, exception.reason, nil);
    }
}

- (void)releasePipelineTextBuffer:(NSString *)bufferId
                           resolve:(RCTPromiseResolveBlock)resolve
                            reject:(RCTPromiseRejectBlock)reject
{
    try {
        std::string bid = [bufferId UTF8String] ?: "";
        std::shared_ptr<TxtLiveEntry> liveToRelease;
        {
            std::lock_guard<std::mutex> lock(g_txt_mutex);
            g_txt_offline.erase(bid);
            auto liveIt = g_txt_live.find(bid);
            if (liveIt != g_txt_live.end()) {
                liveToRelease = liveIt->second;
                g_txt_live.erase(liveIt);
            }
        }
        {
            std::lock_guard<std::mutex> emitLock(g_txt_partial_emit_mutex);
            g_txt_partial_last_emit_ms.erase(bid);
        }
        if (liveToRelease) {
            liveToRelease->release();
        }
        resolve(nil);
    } catch (const std::exception &e) {
        txtRejectWithStdException(reject, e);
    } catch (...) {
        reject(kTxtErrInternalError, @"Unknown releasePipelineTextBuffer error", nil);
    }
}

// ==================== Offline Getters ====================

- (void)getOfflineTextBufferTextSlice:(NSString *)bufferId
                            startUtf16:(double)startUtf16
                              maxUtf16:(double)maxUtf16
                               resolve:(RCTPromiseResolveBlock)resolve
                                reject:(RCTPromiseRejectBlock)reject
{
    @try {
        std::string bid = [bufferId UTF8String] ?: "";
        int s = (int)startUtf16;
        int m = (int)maxUtf16;

        if (s < 0 || m <= 0) {
            reject(kTxtErrSliceInvalid,
                   [NSString stringWithFormat:@"Invalid slice args: start=%d, max=%d", s, m], nil);
            return;
        }
        if (m > kTxtMaxSliceCount) {
            reject(kTxtErrSliceTooLarge,
                   [NSString stringWithFormat:@"maxUtf16 %d exceeds max %d", m, kTxtMaxSliceCount], nil);
            return;
        }

        std::string slice;
        std::string err;
        if (!txt_copy_offline_text_utf16_slice(bid, s, m, &slice, &err)) {
            reject(kTxtErrBufferNotFound,
                   [NSString stringWithFormat:@"Offline text buffer not found: %@", bufferId], nil);
            return;
        }
        resolve([NSString stringWithUTF8String:slice.c_str()] ?: @"");
    } @catch (NSException *exception) {
        reject(kTxtErrInternalError, exception.reason, nil);
    }
}

- (void)getOfflineTextBufferTokensSlice:(NSString *)bufferId
                                  start:(double)start
                               maxCount:(double)maxCount
                                resolve:(RCTPromiseResolveBlock)resolve
                                 reject:(RCTPromiseRejectBlock)reject
{
    @try {
        std::string bid = [bufferId UTF8String] ?: "";
        int s = (int)start;
        int m = (int)maxCount;

        if (s < 0 || m <= 0) {
            reject(kTxtErrSliceInvalid, @"Invalid slice args", nil);
            return;
        }
        if (m > kTxtMaxSliceCount) {
            reject(kTxtErrSliceTooLarge, @"maxCount exceeds max", nil);
            return;
        }

        std::lock_guard<std::mutex> lock(g_txt_mutex);
        auto it = g_txt_offline.find(bid);
        if (it == g_txt_offline.end()) {
            reject(kTxtErrBufferNotFound,
                   [NSString stringWithFormat:@"Offline text buffer not found: %@", bufferId], nil);
            return;
        }

        auto &tokens = it->second->tokens;
        int total = (int)tokens.size();
        if (s >= total) {
            resolve([NSArray array]);
            return;
        }
        int end = MIN(s + m, total);
        NSMutableArray *arr = [NSMutableArray arrayWithCapacity:(end - s)];
        for (int i = s; i < end; i++) {
            [arr addObject:[NSString stringWithUTF8String:tokens[i].c_str()]];
        }
        resolve(arr);
    } @catch (NSException *exception) {
        reject(kTxtErrInternalError, exception.reason, nil);
    }
}

- (void)getOfflineTextBufferTimestampsSlice:(NSString *)bufferId
                                      start:(double)start
                                   maxCount:(double)maxCount
                                    resolve:(RCTPromiseResolveBlock)resolve
                                     reject:(RCTPromiseRejectBlock)reject
{
    @try {
        std::string bid = [bufferId UTF8String] ?: "";
        int s = (int)start;
        int m = (int)maxCount;

        if (s < 0 || m <= 0) {
            reject(kTxtErrSliceInvalid, @"Invalid slice args", nil);
            return;
        }
        if (m > kTxtMaxSliceCount) {
            reject(kTxtErrSliceTooLarge, @"maxCount exceeds max", nil);
            return;
        }

        std::lock_guard<std::mutex> lock(g_txt_mutex);
        auto it = g_txt_offline.find(bid);
        if (it == g_txt_offline.end()) {
            reject(kTxtErrBufferNotFound,
                   [NSString stringWithFormat:@"Offline text buffer not found: %@", bufferId], nil);
            return;
        }

        auto &timestamps = it->second->timestamps;
        int total = (int)timestamps.size();
        if (s >= total) {
            resolve([NSArray array]);
            return;
        }
        int end = MIN(s + m, total);
        NSMutableArray *arr = [NSMutableArray arrayWithCapacity:(end - s)];
        for (int i = s; i < end; i++) {
            [arr addObject:@(timestamps[i])];
        }
        resolve(arr);
    } @catch (NSException *exception) {
        reject(kTxtErrInternalError, exception.reason, nil);
    }
}

- (void)getOfflineTextBufferDurationsSlice:(NSString *)bufferId
                                     start:(double)start
                                  maxCount:(double)maxCount
                                   resolve:(RCTPromiseResolveBlock)resolve
                                    reject:(RCTPromiseRejectBlock)reject
{
    @try {
        std::string bid = [bufferId UTF8String] ?: "";
        int s = (int)start;
        int m = (int)maxCount;

        if (s < 0 || m <= 0) {
            reject(kTxtErrSliceInvalid, @"Invalid slice args", nil);
            return;
        }
        if (m > kTxtMaxSliceCount) {
            reject(kTxtErrSliceTooLarge, @"maxCount exceeds max", nil);
            return;
        }

        std::lock_guard<std::mutex> lock(g_txt_mutex);
        auto it = g_txt_offline.find(bid);
        if (it == g_txt_offline.end()) {
            reject(kTxtErrBufferNotFound,
                   [NSString stringWithFormat:@"Offline text buffer not found: %@", bufferId], nil);
            return;
        }

        auto &durations = it->second->durations;
        int total = (int)durations.size();
        if (s >= total) {
            resolve([NSArray array]);
            return;
        }
        int end = MIN(s + m, total);
        NSMutableArray *arr = [NSMutableArray arrayWithCapacity:(end - s)];
        for (int i = s; i < end; i++) {
            [arr addObject:@(durations[i])];
        }
        resolve(arr);
    } @catch (NSException *exception) {
        reject(kTxtErrInternalError, exception.reason, nil);
    }
}

- (void)getOfflineTextBufferSpatialSpansSlice:(NSString *)bufferId
                                        start:(double)start
                                     maxCount:(double)maxCount
                                      resolve:(RCTPromiseResolveBlock)resolve
                                       reject:(RCTPromiseRejectBlock)reject
{
    @try {
        std::string bid = [bufferId UTF8String] ?: "";
        int s = (int)start;
        int m = (int)maxCount;

        if (s < 0 || m <= 0) {
            reject(kTxtErrSliceInvalid, @"Invalid slice args", nil);
            return;
        }
        if (m > kTxtMaxSliceCount) {
            reject(kTxtErrSliceTooLarge, @"maxCount exceeds max", nil);
            return;
        }

        std::lock_guard<std::mutex> lock(g_txt_mutex);
        auto it = g_txt_offline.find(bid);
        if (it == g_txt_offline.end()) {
            reject(kTxtErrBufferNotFound,
                   [NSString stringWithFormat:@"Offline text buffer not found: %@", bufferId], nil);
            return;
        }

        auto &spans = it->second->spatialSpans;
        int total = (int)spans.size();
        if (s >= total) {
            resolve([NSArray array]);
            return;
        }
        int end = MIN(s + m, total);
        NSMutableArray *arr = [NSMutableArray arrayWithCapacity:(end - s)];
        for (int i = s; i < end; i++) {
            [arr addObject:txtSpatialSpanToDict(spans[i])];
        }
        resolve(arr);
    } @catch (NSException *exception) {
        reject(kTxtErrInternalError, exception.reason, nil);
    }
}

- (void)getOfflineTextBufferLang:(NSString *)bufferId
                          resolve:(RCTPromiseResolveBlock)resolve
                           reject:(RCTPromiseRejectBlock)reject
{
    @try {
        std::string bid = [bufferId UTF8String] ?: "";
        std::lock_guard<std::mutex> lock(g_txt_mutex);
        auto it = g_txt_offline.find(bid);
        if (it == g_txt_offline.end()) {
            reject(kTxtErrBufferNotFound,
                   [NSString stringWithFormat:@"Offline text buffer not found: %@", bufferId], nil);
            return;
        }
        resolve([NSString stringWithUTF8String:it->second->lang.c_str()] ?: @"");
    } @catch (NSException *exception) {
        reject(kTxtErrInternalError, exception.reason, nil);
    }
}

- (void)getOfflineTextBufferEmotion:(NSString *)bufferId
                             resolve:(RCTPromiseResolveBlock)resolve
                              reject:(RCTPromiseRejectBlock)reject
{
    @try {
        std::string bid = [bufferId UTF8String] ?: "";
        std::lock_guard<std::mutex> lock(g_txt_mutex);
        auto it = g_txt_offline.find(bid);
        if (it == g_txt_offline.end()) {
            reject(kTxtErrBufferNotFound,
                   [NSString stringWithFormat:@"Offline text buffer not found: %@", bufferId], nil);
            return;
        }
        resolve([NSString stringWithUTF8String:it->second->emotion.c_str()] ?: @"");
    } @catch (NSException *exception) {
        reject(kTxtErrInternalError, exception.reason, nil);
    }
}

- (void)getOfflineTextBufferEvent:(NSString *)bufferId
                           resolve:(RCTPromiseResolveBlock)resolve
                            reject:(RCTPromiseRejectBlock)reject
{
    @try {
        std::string bid = [bufferId UTF8String] ?: "";
        std::lock_guard<std::mutex> lock(g_txt_mutex);
        auto it = g_txt_offline.find(bid);
        if (it == g_txt_offline.end()) {
            reject(kTxtErrBufferNotFound,
                   [NSString stringWithFormat:@"Offline text buffer not found: %@", bufferId], nil);
            return;
        }
        resolve([NSString stringWithUTF8String:it->second->event.c_str()] ?: @"");
    } @catch (NSException *exception) {
        reject(kTxtErrInternalError, exception.reason, nil);
    }
}

// ==================== Live Getters ====================

- (void)getLiveTextBufferPartialSlice:(NSString *)liveBufferId
                            startUtf16:(double)startUtf16
                              maxUtf16:(double)maxUtf16
                               resolve:(RCTPromiseResolveBlock)resolve
                                reject:(RCTPromiseRejectBlock)reject
{
    @try {
        std::string lid = [liveBufferId UTF8String] ?: "";
        int s = (int)startUtf16;
        int m = (int)maxUtf16;

        if (s < 0 || m <= 0) {
            reject(kTxtErrSliceInvalid, @"Invalid slice args", nil);
            return;
        }

        std::string slice;
        std::string err;
        if (!txt_copy_live_snapshot_utf16_slice(lid, s, m, &slice, &err)) {
            reject(kTxtErrBufferNotFound,
                   [NSString stringWithFormat:@"Live text buffer not found: %@", liveBufferId], nil);
            return;
        }
        resolve([NSString stringWithUTF8String:slice.c_str()] ?: @"");
    } @catch (NSException *exception) {
        reject(kTxtErrInternalError, exception.reason, nil);
    }
}

- (void)setLiveTextBufferPartial:(NSString *)liveBufferId
                            text:(NSString *)text
                         resolve:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject
{
    try {
    @try {
        std::string lid = [liveBufferId UTF8String] ?: "";
        std::string textStr = [text UTF8String] ?: "";

        std::shared_ptr<TxtLiveEntry> entry;
        {
            std::lock_guard<std::mutex> lock(g_txt_mutex);
            auto it = g_txt_live.find(lid);
            if (it == g_txt_live.end()) {
                reject(kTxtErrBufferNotFound,
                       [NSString stringWithFormat:@"Live text buffer not found: %@", liveBufferId], nil);
                return;
            }
            entry = it->second;
        }

        entry->writePartial(textStr);

        resolve(nil);
    } @catch (NSException *exception) {
        reject(kTxtErrInternalError, exception.reason, nil);
        return;
    }
    } catch (const std::exception &e) {
        txtRejectWithStdException(reject, e);
    } catch (...) {
        reject(kTxtErrInternalError, @"Unknown setLiveTextBufferPartial error", nil);
    }
}

- (void)appendLiveTextBufferPartial:(NSString *)liveBufferId
                               text:(NSString *)text
                            resolve:(RCTPromiseResolveBlock)resolve
                             reject:(RCTPromiseRejectBlock)reject
{
    try {
    @try {
        std::string lid = [liveBufferId UTF8String] ?: "";
        std::string textStr = [text UTF8String] ?: "";

        std::shared_ptr<TxtLiveEntry> entry;
        {
            std::lock_guard<std::mutex> lock(g_txt_mutex);
            auto it = g_txt_live.find(lid);
            if (it == g_txt_live.end()) {
                reject(kTxtErrBufferNotFound,
                       [NSString stringWithFormat:@"Live text buffer not found: %@", liveBufferId], nil);
                return;
            }
            entry = it->second;
        }

        entry->appendText(textStr);

        resolve(nil);
    } @catch (NSException *exception) {
        reject(kTxtErrInternalError, exception.reason, nil);
        return;
    }
    } catch (const std::exception &e) {
        txtRejectWithStdException(reject, e);
    } catch (...) {
        reject(kTxtErrInternalError, @"Unknown appendLiveTextBufferPartial error", nil);
    }
}

- (void)appendLiveTextSegment:(NSString *)liveBufferId
                          text:(NSString *)text
                        tokens:(NSArray *)tokens
                    timestamps:(NSArray *)timestamps
                          meta:(NSDictionary *)meta
                       resolve:(RCTPromiseResolveBlock)resolve
                        reject:(RCTPromiseRejectBlock)reject
{
    try {
    @try {
        std::string lid = [liveBufferId UTF8String] ?: "";
        std::string textStr = [text UTF8String] ?: "";

        std::shared_ptr<TxtLiveEntry> entry;
        {
            std::lock_guard<std::mutex> lock(g_txt_mutex);
            auto it = g_txt_live.find(lid);
            if (it == g_txt_live.end()) {
                reject(kTxtErrBufferNotFound,
                       [NSString stringWithFormat:@"Live text buffer not found: %@", liveBufferId], nil);
                return;
            }
            entry = it->second;
        }

        std::vector<std::string> tokenVec;
        if (tokens != nil) {
            tokenVec.reserve(tokens.count);
            for (id obj in tokens) {
                if ([obj isKindOfClass:[NSString class]]) {
                    tokenVec.emplace_back([(NSString *)obj UTF8String] ?: "");
                }
            }
        }

        std::vector<float> timestampVec;
        if (timestamps != nil) {
            timestampVec.reserve(timestamps.count);
            for (id obj in timestamps) {
                if ([obj isKindOfClass:[NSNumber class]]) {
                    timestampVec.emplace_back([(NSNumber *)obj floatValue]);
                }
            }
        }

        int segmentIndex = entry->commitSegment(textStr, tokenVec, timestampVec, "append", txtMetaJsonFromDict(meta));
        resolve(@{ @"segmentIndex": @(segmentIndex) });
    } @catch (NSException *exception) {
        reject(kTxtErrInternalError, exception.reason, nil);
        return;
    }
    } catch (const std::exception &e) {
        txtRejectWithStdException(reject, e);
    } catch (...) {
        reject(kTxtErrInternalError, @"Unknown appendLiveTextSegment error", nil);
    }
}

- (void)getLiveTextBufferSegments:(NSString *)liveBufferId
                        startIndex:(double)startIndex
                          maxCount:(double)maxCount
                           options:(JS::NativeSherpaOnnx::SpecGetLiveTextBufferSegmentsOptions &)options
                           resolve:(RCTPromiseResolveBlock)resolve
                            reject:(RCTPromiseRejectBlock)reject
{
    try {
    @try {
        std::string lid = [liveBufferId UTF8String] ?: "";
        int s = (int)startIndex;
        int m = (int)maxCount;

        if (s < 0 || m <= 0) {
            reject(kTxtErrSliceInvalid, @"Invalid slice args", nil);
            return;
        }
        if (m > kTxtMaxSliceCount) {
            reject(kTxtErrSliceTooLarge,
                   [NSString stringWithFormat:@"maxCount %d exceeds max %d", m, kTxtMaxSliceCount], nil);
            return;
        }

        std::shared_ptr<TxtLiveEntry> entry;
        {
            std::lock_guard<std::mutex> lock(g_txt_mutex);
            auto it = g_txt_live.find(lid);
            if (it == g_txt_live.end()) {
                reject(kTxtErrBufferNotFound,
                       [NSString stringWithFormat:@"Live text buffer not found: %@", liveBufferId], nil);
                return;
            }
            entry = it->second;
        }

        auto includeTokensOpt = options.includeTokens();
        BOOL includeTokens = includeTokensOpt.has_value() ? includeTokensOpt.value() : NO;
        auto includeTimestampsOpt = options.includeTimestamps();
        BOOL includeTimestamps = includeTimestampsOpt.has_value() ? includeTimestampsOpt.value() : NO;
        auto includeMetaOpt = options.includeMeta();
        BOOL includeMeta = includeMetaOpt.has_value() ? includeMetaOpt.value() : NO;

        auto segments = entry->getSegments(s, m);
        NSMutableArray *segmentArray = [NSMutableArray arrayWithCapacity:segments.size()];
        for (const auto &seg : segments) {
            NSMutableDictionary *segmentMap = [@{
                @"text": [NSString stringWithUTF8String:seg.text.c_str()] ?: @"",
                @"source": [NSString stringWithUTF8String:seg.source.c_str()] ?: @"unknown",
                @"segmentIndex": @(seg.segmentIndex),
            } mutableCopy];

            if (includeTokens) {
                NSMutableArray *tokenArr = [NSMutableArray arrayWithCapacity:seg.tokens.size()];
                for (const auto &tok : seg.tokens) {
                    [tokenArr addObject:[NSString stringWithUTF8String:tok.c_str()] ?: @""];
                }
                segmentMap[@"tokens"] = tokenArr;
            }

            if (includeTimestamps) {
                NSMutableArray *tsArr = [NSMutableArray arrayWithCapacity:seg.timestamps.size()];
                for (float ts : seg.timestamps) {
                    [tsArr addObject:@(ts)];
                }
                segmentMap[@"timestamps"] = tsArr;
            }

            if (includeMeta && !seg.metaJson.empty()) {
                NSDictionary *metaDict = txtMetaDictFromJson(seg.metaJson);
                if (metaDict != nil) {
                    segmentMap[@"meta"] = metaDict;
                }
            }

            [segmentArray addObject:segmentMap];
        }

        resolve(@{ @"segments": segmentArray });
    } @catch (NSException *exception) {
        reject(kTxtErrInternalError, exception.reason, nil);
        return;
    }
    } catch (const std::exception &e) {
        reject(kTxtErrInternalError, [NSString stringWithUTF8String:e.what()], nil);
    } catch (...) {
        reject(kTxtErrInternalError, @"Unknown getLiveTextBufferSegments error", nil);
    }
}

- (void)getLiveTextBufferSegmentCount:(NSString *)liveBufferId
                              resolve:(RCTPromiseResolveBlock)resolve
                               reject:(RCTPromiseRejectBlock)reject
{
    @try {
        std::string lid = [liveBufferId UTF8String] ?: "";
        std::lock_guard<std::mutex> lock(g_txt_mutex);
        auto it = g_txt_live.find(lid);
        if (it == g_txt_live.end()) {
            reject(kTxtErrBufferNotFound,
                   [NSString stringWithFormat:@"Live text buffer not found: %@", liveBufferId], nil);
            return;
        }
        resolve(@(it->second->segmentCount()));
    } @catch (NSException *exception) {
        reject(kTxtErrInternalError, exception.reason, nil);
    }
}

@end
