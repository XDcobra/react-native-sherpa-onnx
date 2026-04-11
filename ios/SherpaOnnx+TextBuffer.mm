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

#import "SherpaOnnx.h"
#import "SherpaOnnx+TextBufferGlobals.h"
#import <React/RCTLog.h>
#include <mutex>
#include <unordered_map>
#include <vector>
#include <string>
#include <atomic>

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
static NSString *const kTxtErrInternalError    = @"TEXT_INTERNAL_ERROR";

static const int kTxtMaxSliceCount = 16384;

// ==================== Offline Text Entry ====================
struct TxtOfflineEntry {
    std::string bufferId;
    std::string text;
    std::vector<std::string> tokens;
    std::vector<float> timestamps;
    std::vector<float> durations;
    std::string lang;
    std::string emotion;
    std::string event;
    bool populated = false;

    int utf16Length() const {
        // NSString length gives UTF-16 count, which matches JavaScript string.length
        NSString *ns = [NSString stringWithUTF8String:text.c_str()];
        return ns ? (int)[ns length] : 0;
    }
    int tokenCount() const { return (int)tokens.size(); }
    int timestampCount() const { return (int)timestamps.size(); }
    int durationCount() const { return (int)durations.size(); }
    bool hasLang() const { return !lang.empty(); }
    bool hasEmotion() const { return !emotion.empty(); }
    bool hasEvent() const { return !event.empty(); }

    void populate(const std::string &t, const std::vector<std::string> &tok,
                  const std::vector<float> &ts, const std::vector<float> &dur,
                  const std::string &l, const std::string &em, const std::string &ev) {
        if (populated) return; // already populated, no-op (or could throw)
        text = t;
        tokens = tok;
        timestamps = ts;
        durations = dur;
        lang = l;
        emotion = em;
        event = ev;
        populated = true;
    }

    NSDictionary *toDict() const {
        return @{
            @"bufferId": [NSString stringWithUTF8String:bufferId.c_str()],
            @"kind": @"offlineTextBuffer",
            @"state": @"immutable",
            @"utf16Length": @(utf16Length()),
            @"tokenCount": @(tokenCount()),
            @"timestampCount": @(timestampCount()),
            @"durationCount": @(durationCount()),
            @"hasLang": @(hasLang()),
            @"hasEmotion": @(hasEmotion()),
            @"hasEvent": @(hasEvent()),
        };
    }
};

// ==================== Live Text Entry ====================
struct TxtLiveEntry {
    enum State { RECORDING, FINISHED };

    std::string bufferId;
    State state = RECORDING;
    std::string currentText;
    int64_t totalCharsWritten = 0;
    std::atomic<int> revision{0};
    int windowMaxChars = 65536;
    bool emitPartialEvents = false;
    int64_t partialEventMinIntervalMs = 0;

    void writePartial(const std::string &text) {
        // Convert to NSString for UTF-16 length handling
        NSString *ns = [NSString stringWithUTF8String:text.c_str()];
        int len = ns ? (int)[ns length] : 0;
        if (len > windowMaxChars) {
            NSString *trimmed = [ns substringFromIndex:(len - windowMaxChars)];
            currentText = [trimmed UTF8String] ?: "";
        } else {
            currentText = text;
        }
        totalCharsWritten += len;
        revision.fetch_add(1);
    }

    void appendText(const std::string &text) {
        std::string combined = currentText + text;
        NSString *ns = [NSString stringWithUTF8String:combined.c_str()];
        int len = ns ? (int)[ns length] : 0;
        NSString *textNs = [NSString stringWithUTF8String:text.c_str()];
        int appendLen = textNs ? (int)[textNs length] : 0;
        if (len > windowMaxChars) {
            NSString *trimmed = [ns substringFromIndex:(len - windowMaxChars)];
            currentText = [trimmed UTF8String] ?: "";
        } else {
            currentText = combined;
        }
        totalCharsWritten += appendLen;
        revision.fetch_add(1);
    }

    void finalize_() {
        state = FINISHED;
    }

    std::string snapshotText() const {
        return currentText;
    }

    NSDictionary *toDict() const {
        return @{
            @"bufferId": [NSString stringWithUTF8String:bufferId.c_str()],
            @"kind": @"liveTextBuffer",
            @"state": state == RECORDING ? @"recording" : @"finished",
            @"totalCharsWritten": @(totalCharsWritten),
            @"revision": @(revision.load()),
        };
    }
};

// ==================== Registry ====================

// Non-static: shared with SherpaOnnx+STT.mm via SherpaOnnx+TextBufferGlobals.h
std::unordered_map<std::string, std::shared_ptr<TxtOfflineEntry>> g_txt_offline;
std::unordered_map<std::string, std::shared_ptr<TxtLiveEntry>> g_txt_live;
std::mutex g_txt_mutex;

static std::string txt_generateId(const char *prefix) {
    return std::string(prefix) + "_" + [[[NSUUID UUID] UUIDString] UTF8String];
}

// ==================== TurboModule Methods ====================

@implementation SherpaOnnx (TextBuffer)

- (void)createEmptyOfflineTextBuffer:(RCTPromiseResolveBlock)resolve
                              reject:(RCTPromiseRejectBlock)reject
{
    @try {
        std::string bufferId = txt_generateId("txt_off");
        auto entry = std::make_shared<TxtOfflineEntry>();
        entry->bufferId = bufferId;
        {
            std::lock_guard<std::mutex> lock(g_txt_mutex);
            g_txt_offline[bufferId] = entry;
        }
        resolve(entry->toDict());
    } @catch (NSException *exception) {
        reject(kTxtErrInternalError, exception.reason, nil);
    }
}

- (void)createOfflineTextBufferFromLive:(NSString *)liveBufferId
                                   mode:(NSString *)mode
                                resolve:(RCTPromiseResolveBlock)resolve
                                 reject:(RCTPromiseRejectBlock)reject
{
    @try {
        std::string liveId = [liveBufferId UTF8String] ?: "";
        std::string modeStr = mode ? [mode UTF8String] : "fullIfSpooled";

        std::lock_guard<std::mutex> lock(g_txt_mutex);
        auto it = g_txt_live.find(liveId);
        if (it == g_txt_live.end()) {
            reject(kTxtErrBufferNotFound,
                   [NSString stringWithFormat:@"Live text buffer not found: %@", liveBufferId], nil);
            return;
        }

        std::string text = it->second->snapshotText();
        std::string bufferId = txt_generateId("txt_off");
        auto entry = std::make_shared<TxtOfflineEntry>();
        entry->bufferId = bufferId;
        if (!text.empty()) {
            entry->text = text;
            entry->populated = true;
        }
        g_txt_offline[bufferId] = entry;
        resolve(entry->toDict());
    } @catch (NSException *exception) {
        reject(kTxtErrInternalError, exception.reason, nil);
    }
}

- (void)createLiveTextBuffer:(NSDictionary *)options
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject
{
    @try {
        int windowMaxChars = 65536;
        bool emitPartialEvents = false;
        int64_t partialEventMinIntervalMs = 0;

        if (options[@"windowMaxChars"]) {
            windowMaxChars = [options[@"windowMaxChars"] intValue];
        }
        if (options[@"emitPartialEvents"]) {
            emitPartialEvents = [options[@"emitPartialEvents"] boolValue];
        }
        if (options[@"partialEventMinIntervalMs"]) {
            partialEventMinIntervalMs = [options[@"partialEventMinIntervalMs"] longLongValue];
        }

        std::string bufferId = txt_generateId("txt_live");
        auto entry = std::make_shared<TxtLiveEntry>();
        entry->bufferId = bufferId;
        entry->windowMaxChars = windowMaxChars;
        entry->emitPartialEvents = emitPartialEvents;
        entry->partialEventMinIntervalMs = partialEventMinIntervalMs;
        {
            std::lock_guard<std::mutex> lock(g_txt_mutex);
            g_txt_live[bufferId] = entry;
        }
        resolve(entry->toDict());
    } @catch (NSException *exception) {
        reject(kTxtErrInternalError, exception.reason, nil);
    }
}

- (void)createLiveTextBufferFromOffline:(NSString *)offlineBufferId
                                 resolve:(RCTPromiseResolveBlock)resolve
                                  reject:(RCTPromiseRejectBlock)reject
{
    @try {
        std::string offId = [offlineBufferId UTF8String] ?: "";

        std::lock_guard<std::mutex> lock(g_txt_mutex);
        auto it = g_txt_offline.find(offId);
        if (it == g_txt_offline.end()) {
            reject(kTxtErrBufferNotFound,
                   [NSString stringWithFormat:@"Offline text buffer not found: %@", offlineBufferId], nil);
            return;
        }

        std::string bufferId = txt_generateId("txt_live");
        auto entry = std::make_shared<TxtLiveEntry>();
        entry->bufferId = bufferId;
        if (!it->second->text.empty()) {
            entry->writePartial(it->second->text);
        }
        g_txt_live[bufferId] = entry;
        resolve(entry->toDict());
    } @catch (NSException *exception) {
        reject(kTxtErrInternalError, exception.reason, nil);
    }
}

- (void)finalizeLiveTextBuffer:(NSString *)liveBufferId
                        resolve:(RCTPromiseResolveBlock)resolve
                         reject:(RCTPromiseRejectBlock)reject
{
    @try {
        std::string liveId = [liveBufferId UTF8String] ?: "";

        std::lock_guard<std::mutex> lock(g_txt_mutex);
        auto it = g_txt_live.find(liveId);
        if (it == g_txt_live.end()) {
            reject(kTxtErrBufferNotFound,
                   [NSString stringWithFormat:@"Live text buffer not found: %@", liveBufferId], nil);
            return;
        }
        if (it->second->state == TxtLiveEntry::FINISHED) {
            reject(kTxtErrAlreadyFinalized, @"Live text buffer already finalized", nil);
            return;
        }
        it->second->finalize_();
        resolve(nil);
    } @catch (NSException *exception) {
        reject(kTxtErrInternalError, exception.reason, nil);
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
            resolve(offIt->second->toDict());
            return;
        }
        auto liveIt = g_txt_live.find(bid);
        if (liveIt != g_txt_live.end()) {
            resolve(liveIt->second->toDict());
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
    @try {
        std::string bid = [bufferId UTF8String] ?: "";
        {
            std::lock_guard<std::mutex> lock(g_txt_mutex);
            g_txt_offline.erase(bid);
            g_txt_live.erase(bid);
        }
        resolve(nil);
    } @catch (NSException *exception) {
        reject(kTxtErrInternalError, exception.reason, nil);
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

        std::lock_guard<std::mutex> lock(g_txt_mutex);
        auto it = g_txt_offline.find(bid);
        if (it == g_txt_offline.end()) {
            reject(kTxtErrBufferNotFound,
                   [NSString stringWithFormat:@"Offline text buffer not found: %@", bufferId], nil);
            return;
        }

        NSString *full = [NSString stringWithUTF8String:it->second->text.c_str()] ?: @"";
        int totalLen = (int)[full length];
        if (s >= totalLen) {
            resolve(@"");
            return;
        }
        int end = MIN(s + m, totalLen);
        NSRange range = NSMakeRange(s, end - s);
        resolve([full substringWithRange:range]);
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

        std::lock_guard<std::mutex> lock(g_txt_mutex);
        auto it = g_txt_live.find(lid);
        if (it == g_txt_live.end()) {
            reject(kTxtErrBufferNotFound,
                   [NSString stringWithFormat:@"Live text buffer not found: %@", liveBufferId], nil);
            return;
        }

        NSString *full = [NSString stringWithUTF8String:it->second->currentText.c_str()] ?: @"";
        int totalLen = (int)[full length];
        if (s >= totalLen) {
            resolve(@"");
            return;
        }
        int end = MIN(s + m, totalLen);
        NSRange range = NSMakeRange(s, end - s);
        resolve([full substringWithRange:range]);
    } @catch (NSException *exception) {
        reject(kTxtErrInternalError, exception.reason, nil);
    }
}

@end
