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
#include <deque>
#include <algorithm>
#include <stdexcept>

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

// ==================== Text Segment ====================
struct TextSegment {
    std::string text;
    std::vector<std::string> tokens;
    std::vector<float> timestamps;
    std::string source;
    int segmentIndex;
    NSDictionary *meta = nil;
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
    int maxSegments = 1000;
    bool emitPartialEvents = false;
    int64_t partialEventMinIntervalMs = 0;

    // ── Segment log (ring with maxSegments capacity) ──
    std::deque<TextSegment> segments;
    std::mutex segmentMutex;
    int64_t evictedCount = 0;

    int segmentCount() {
        std::lock_guard<std::mutex> lock(segmentMutex);
        return (int)segments.size();
    }

    // ── Cursor system ──
    struct SegmentCursor {
        int cursorId;
        std::atomic<int> readPos{0};
    };
    std::unordered_map<int, std::unique_ptr<SegmentCursor>> segmentCursors;
    std::mutex cursorMutex;
    std::atomic<int> nextCursorId{0};

    int createSegmentCursor() {
        int id = nextCursorId.fetch_add(1);
        auto cursor = std::make_unique<SegmentCursor>();
        cursor->cursorId = id;
        cursor->readPos.store(0);
        std::lock_guard<std::mutex> lock(cursorMutex);
        segmentCursors[id] = std::move(cursor);
        return id;
    }

    std::vector<TextSegment> drainSegments(int cursorId, int maxCount) {
        std::lock_guard<std::mutex> cLock(cursorMutex);
        auto it = segmentCursors.find(cursorId);
        if (it == segmentCursors.end()) return {};
        std::lock_guard<std::mutex> sLock(segmentMutex);
        int pos = it->second->readPos.load();
        if (pos >= (int)segments.size()) return {};
        int end = std::min(pos + maxCount, (int)segments.size());
        std::vector<TextSegment> result(segments.begin() + pos, segments.begin() + end);
        it->second->readPos.store(end);
        return result;
    }

    std::vector<TextSegment> getSegments(int startIndex, int maxCount) {
        if (startIndex < 0 || maxCount <= 0) return {};
        std::lock_guard<std::mutex> sLock(segmentMutex);
        if (startIndex >= (int)segments.size()) return {};
        int end = std::min(startIndex + maxCount, (int)segments.size());
        return std::vector<TextSegment>(segments.begin() + startIndex, segments.begin() + end);
    }

    void releaseSegmentCursor(int cursorId) {
        std::lock_guard<std::mutex> lock(cursorMutex);
        segmentCursors.erase(cursorId);
    }

    // ── Append listeners (token-based) ──
    struct NativeAppendListener {
        int token;
        std::function<void()> callback;
    };
    std::vector<NativeAppendListener> appendListeners;
    std::mutex appendListenerMutex;
    std::atomic<int> nextListenerToken{0};

    int addAppendListener(std::function<void()> listener) {
        int token = nextListenerToken.fetch_add(1);
        std::lock_guard<std::mutex> lock(appendListenerMutex);
        appendListeners.push_back({token, std::move(listener)});
        return token;
    }

    void removeAppendListener(int token) {
        std::lock_guard<std::mutex> lock(appendListenerMutex);
        appendListeners.erase(
            std::remove_if(appendListeners.begin(), appendListeners.end(),
                           [token](const NativeAppendListener &l) { return l.token == token; }),
            appendListeners.end());
    }

    void notifyAppendListeners() {
        std::vector<std::function<void()>> callbacks;
        {
            std::lock_guard<std::mutex> lock(appendListenerMutex);
            callbacks.reserve(appendListeners.size());
            for (auto &l : appendListeners) callbacks.push_back(l.callback);
        }
        for (auto &cb : callbacks) cb();
    }

    // ── Partial text ──
    void writePartial(const std::string &text) {
        if (state == FINISHED) {
            throw std::runtime_error("Live text buffer is finalized: " + bufferId);
        }
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
        if (state == FINISHED) {
            throw std::runtime_error("Live text buffer is finalized: " + bufferId);
        }
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

    int commitSegment(const std::string &text,
                      const std::vector<std::string> &tokens = {},
                      const std::vector<float> &timestamps = {},
                      const std::string &source = "unknown",
                      NSDictionary *meta = nil) {
        if (state == FINISHED) {
            throw std::runtime_error("Live text buffer is finalized: " + bufferId);
        }
        int committedSegmentIndex = -1;
        {
            std::lock_guard<std::mutex> lock(segmentMutex);
            TextSegment seg;
            seg.text = text;
            seg.tokens = tokens;
            seg.timestamps = timestamps;
            seg.source = source;
            seg.segmentIndex = (int)(evictedCount + (int64_t)segments.size());
            seg.meta = meta;
            committedSegmentIndex = seg.segmentIndex;
            segments.push_back(std::move(seg));
            // Evict oldest if over capacity
            if ((int)segments.size() > maxSegments) {
                segments.pop_front();
                evictedCount++;
                // Snap cursors forward
                std::lock_guard<std::mutex> cLock(cursorMutex);
                for (auto &pair : segmentCursors) {
                    int p = pair.second->readPos.load();
                    if (p > 0) pair.second->readPos.fetch_sub(1);
                    else pair.second->readPos.store(0);
                }
            }
            NSString *textNs = [NSString stringWithUTF8String:text.c_str()];
            int charLen = textNs ? (int)[textNs length] : 0;
            totalCharsWritten += charLen;
            revision.fetch_add(1);
        }
        notifyAppendListeners();
        return committedSegmentIndex;
    }

    void finalize_() {
        if (state == FINISHED) {
            throw std::runtime_error("Already finalized: " + bufferId);
        }
        state = FINISHED;
        notifyAppendListeners();
    }

    std::string snapshotText() const {
        return currentText;
    }

    NSDictionary *toDict() {
        return @{
            @"bufferId": [NSString stringWithUTF8String:bufferId.c_str()],
            @"kind": @"liveTextBuffer",
            @"state": state == RECORDING ? @"recording" : @"finished",
            @"totalCharsWritten": @(totalCharsWritten),
            @"revision": @(revision.load()),
            @"segmentCount": @(segmentCount()),
        };
    }
};

// ==================== Registry ====================

// Non-static: shared with SherpaOnnx+STT.mm via SherpaOnnx+TextBufferGlobals.h
std::unordered_map<std::string, std::shared_ptr<TxtOfflineEntry>> g_txt_offline;
std::unordered_map<std::string, std::shared_ptr<TxtLiveEntry>> g_txt_live;
std::mutex g_txt_mutex;

std::shared_ptr<TxtLiveEntry> txt_get_live_entry(const std::string &bufferId) {
    std::lock_guard<std::mutex> lock(g_txt_mutex);
    auto it = g_txt_live.find(bufferId);
    if (it == g_txt_live.end()) {
        return nullptr;
    }
    return it->second;
}

bool txt_live_is_recording(const std::shared_ptr<TxtLiveEntry> &entry) {
    if (!entry) return false;
    return entry->state == TxtLiveEntry::RECORDING;
}

bool txt_live_write_partial(
    const std::shared_ptr<TxtLiveEntry> &entry,
    const std::string &text,
    std::string *error
) {
    if (!entry) {
        if (error) *error = "Live text buffer not found";
        return false;
    }
    try {
        entry->writePartial(text);
        return true;
    } catch (const std::exception &e) {
        if (error) *error = e.what();
        return false;
    } catch (...) {
        if (error) *error = "Unknown live text writePartial error";
        return false;
    }
}

bool txt_live_commit_segment(
    const std::shared_ptr<TxtLiveEntry> &entry,
    const std::string &text,
    const std::vector<std::string> &tokens,
    const std::vector<float> &timestamps,
    const std::string &source,
    NSDictionary *meta,
    std::string *error
) {
    if (!entry) {
        if (error) *error = "Live text buffer not found";
        return false;
    }
    try {
        entry->commitSegment(text, tokens, timestamps, source, meta);
        return true;
    } catch (const std::exception &e) {
        if (error) *error = e.what();
        return false;
    } catch (...) {
        if (error) *error = "Unknown live text commitSegment error";
        return false;
    }
}

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

- (void)createOfflineTextBufferFromText:(NSString *)text
                                options:(NSDictionary *)options
                                resolve:(RCTPromiseResolveBlock)resolve
                                 reject:(RCTPromiseRejectBlock)reject
{
    @try {
        if (text == nil || [text length] == 0) {
            reject(kTxtErrInvalidArgument, @"text must not be empty", nil);
            return;
        }
        std::string bufferId = txt_generateId("txt_off");
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
        int maxSegments = 1000;
        bool emitPartialEvents = false;
        int64_t partialEventMinIntervalMs = 0;

        if (options[@"windowMaxChars"]) {
            windowMaxChars = [options[@"windowMaxChars"] intValue];
        }
        if (options[@"maxSegments"]) {
            maxSegments = [options[@"maxSegments"] intValue];
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
        entry->maxSegments = maxSegments;
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

- (void)appendLiveTextSegment:(NSString *)liveBufferId
                          text:(NSString *)text
                        tokens:(NSArray<NSString *> *)tokens
                    timestamps:(NSArray<NSNumber *> *)timestamps
                          meta:(NSDictionary *)meta
                       resolve:(RCTPromiseResolveBlock)resolve
                        reject:(RCTPromiseRejectBlock)reject
{
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

        int segmentIndex = entry->commitSegment(textStr, tokenVec, timestampVec, "append", meta);
        resolve(@{ @"segmentIndex": @(segmentIndex) });
    } @catch (NSException *exception) {
        reject(kTxtErrInternalError, exception.reason, nil);
    } catch (const std::runtime_error &e) {
        reject(kTxtErrAlreadyFinalized, [NSString stringWithUTF8String:e.what()], nil);
    } catch (const std::exception &e) {
        reject(kTxtErrInternalError, [NSString stringWithUTF8String:e.what()], nil);
    } catch (...) {
        reject(kTxtErrInternalError, @"Unknown appendLiveTextSegment error", nil);
    }
}

- (void)getLiveTextBufferSegments:(NSString *)liveBufferId
                        startIndex:(double)startIndex
                          maxCount:(double)maxCount
                           options:(NSDictionary *)options
                           resolve:(RCTPromiseResolveBlock)resolve
                            reject:(RCTPromiseRejectBlock)reject
{
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

        BOOL includeTokens = options != nil && options[@"includeTokens"] != nil
            ? [options[@"includeTokens"] boolValue]
            : NO;
        BOOL includeTimestamps = options != nil && options[@"includeTimestamps"] != nil
            ? [options[@"includeTimestamps"] boolValue]
            : NO;
        BOOL includeMeta = options != nil && options[@"includeMeta"] != nil
            ? [options[@"includeMeta"] boolValue]
            : NO;

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

            if (includeMeta && seg.meta != nil) {
                segmentMap[@"meta"] = seg.meta;
            }

            [segmentArray addObject:segmentMap];
        }

        resolve(@{ @"segments": segmentArray });
    } @catch (NSException *exception) {
        reject(kTxtErrInternalError, exception.reason, nil);
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
