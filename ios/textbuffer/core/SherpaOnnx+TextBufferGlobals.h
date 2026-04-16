#pragma once

#ifdef __cplusplus
#ifdef __OBJC__
#import <Foundation/Foundation.h>
#endif
#include <memory>
#include <algorithm>
#include <atomic>
#include <deque>
#include <functional>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>
#include <stdexcept>

// Forward declarations of pipeline text entry structs (defined below or in textbuffer/bridge/SherpaOnnx+TextBuffer.mm).
struct TxtOfflineEntry;

// Shared live text buffer types used by the text pipeline workers.
struct TextSegment {
	std::string text;
	std::vector<std::string> tokens;
	std::vector<float> timestamps;
	std::string source;
	int segmentIndex;
	NSDictionary *meta = nil;
};

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

	std::deque<TextSegment> segments;
	std::mutex segmentMutex;
	int64_t evictedCount = 0;

	int segmentCount() {
		std::lock_guard<std::mutex> lock(segmentMutex);
		return (int)segments.size();
	}

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

	void writePartial(const std::string &text) {
		if (state == FINISHED) {
			throw std::runtime_error("Live text buffer is finalized: " + bufferId);
		}
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
			if ((int)segments.size() > maxSegments) {
				segments.pop_front();
				evictedCount++;
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

// Global pipeline text registry – shared across textbuffer/bridge/SherpaOnnx+TextBuffer.mm and stt/bridge/SherpaOnnx+STT.mm.
extern std::unordered_map<std::string, std::shared_ptr<TxtOfflineEntry>> g_txt_offline;
extern std::unordered_map<std::string, std::shared_ptr<TxtLiveEntry>> g_txt_live;
extern std::mutex g_txt_mutex;

// Helper APIs for cross-file live-text access (keeps TxtLiveEntry internals encapsulated in .mm).
std::shared_ptr<TxtLiveEntry> txt_get_live_entry(const std::string &bufferId);
bool txt_live_is_recording(const std::shared_ptr<TxtLiveEntry> &entry);
bool txt_live_write_partial(
	const std::shared_ptr<TxtLiveEntry> &entry,
	const std::string &text,
	std::string *error = nullptr
);
bool txt_live_commit_segment(
	const std::shared_ptr<TxtLiveEntry> &entry,
	const std::string &text,
	const std::vector<std::string> &tokens,
	const std::vector<float> &timestamps,
	const std::string &source,
	NSDictionary *meta = nil,
	std::string *error = nullptr
);

// Read an offline text buffer content by id.
bool txt_read_offline_text(
	const std::string &bufferId,
	std::string *text,
	std::string *error = nullptr
);

bool txt_populate_offline_if_empty(
	const std::string &bufferId,
	const std::string &text,
	const std::vector<std::string> &tokens,
	const std::vector<float> &timestamps,
	const std::vector<float> &durations,
	const std::string &lang,
	const std::string &emotion,
	const std::string &event,
	std::string *error = nullptr
);
#endif
