#pragma once

#ifdef __cplusplus
#ifdef __OBJC__
#import <Foundation/Foundation.h>
#endif
#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <unistd.h>
#include <vector>

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
	enum SpoolingMode { SPOOL_OFF, SPOOL_AUTO, SPOOL_ON };

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

	SpoolingMode spoolingMode = SPOOL_ON;
	std::string spoolPath;
	bool spoolTemporary = true;
	int64_t spoolThresholdBytes = 0;
	bool spoolReady = false;
	int64_t spoolBytes = 0;
	int64_t spoolEstimatedBytes = 0;
	std::string spoolFailureCode;
	std::string spoolFailureMessage;

	std::mutex stateMutex;
	std::mutex spoolMutex;
	FILE *spoolFile = nullptr;

	~TxtLiveEntry() {
		try {
			release();
		} catch (...) {
			// best-effort
		}
	}

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

	static std::string spoolingModeRaw(SpoolingMode mode) {
		switch (mode) {
			case SPOOL_OFF: return "off";
			case SPOOL_AUTO: return "auto";
			case SPOOL_ON: return "on";
		}
		return "off";
	}

	bool spoolEnabled() const {
		return spoolingMode != SPOOL_OFF;
	}

	std::runtime_error makeCodedError(const std::string &code, const std::string &message) {
		return std::runtime_error(code + ": " + message);
	}

	[[noreturn]] void throwSpoolError(const std::string &code, const std::string &message) {
		spoolFailureCode = code;
		spoolFailureMessage = message;
		throw makeCodedError(code, message);
	}

	std::string committedTextFromSegmentsLocked() {
		std::string committed;
		for (const auto &seg : segments) {
			committed += seg.text;
		}
		return committed;
	}

	std::string currentFullSnapshotLocked() {
		std::lock_guard<std::mutex> segmentLock(segmentMutex);
		return committedTextFromSegmentsLocked() + currentText;
	}

	void closeSpoolFileLocked(bool flushFirst) {
		if (spoolFile == nullptr) {
			return;
		}
		if (flushFirst) {
			fflush(spoolFile);
		}
		fclose(spoolFile);
		spoolFile = nullptr;
	}

	void appendSnapshotRecordLocked(const std::string &snapshot) {
		if (spoolFile == nullptr) {
			throwSpoolError("TEXT_SPOOL_WRITE_FAILED", "Spool file is not open for " + bufferId);
		}

		const uint32_t len = (uint32_t)snapshot.size();
		unsigned char header[4] = {
			(unsigned char)(len & 0xFF),
			(unsigned char)((len >> 8) & 0xFF),
			(unsigned char)((len >> 16) & 0xFF),
			(unsigned char)((len >> 24) & 0xFF)
		};

		const int64_t recordLength = 4 + (int64_t)len;
		if (fseek(spoolFile, 0, SEEK_SET) != 0) {
			throwSpoolError("TEXT_SPOOL_WRITE_FAILED", "Failed to seek text spool for " + bufferId);
		}
		if (fwrite(header, 1, 4, spoolFile) != 4) {
			throwSpoolError("TEXT_SPOOL_WRITE_FAILED", "Failed to write spool header for " + bufferId);
		}
		if (len > 0 && fwrite(snapshot.data(), 1, len, spoolFile) != len) {
			throwSpoolError("TEXT_SPOOL_WRITE_FAILED", "Failed to write spool payload for " + bufferId);
		}
		if (fflush(spoolFile) != 0) {
			throwSpoolError("TEXT_SPOOL_WRITE_FAILED", "Failed to flush text spool for " + bufferId);
		}
		if (ftruncate(fileno(spoolFile), recordLength) != 0) {
			throwSpoolError("TEXT_SPOOL_WRITE_FAILED", "Failed to truncate text spool for " + bufferId);
		}
		spoolBytes = recordLength;
		spoolReady = true;
	}

	void ensureSpoolWriterActivatedLocked(const std::string &bootstrapSnapshot) {
		if (spoolFile != nullptr) {
			return;
		}
		if (spoolPath.empty()) {
			throwSpoolError("TEXT_SPOOL_UNAVAILABLE", "Text spool path is not configured for " + bufferId);
		}

		NSString *spoolPathNs = [NSString stringWithUTF8String:spoolPath.c_str()];
		NSString *parentPath = [spoolPathNs stringByDeletingLastPathComponent];
		if (parentPath.length > 0) {
			[[NSFileManager defaultManager] createDirectoryAtPath:parentPath
											withIntermediateDirectories:YES
													 attributes:nil
													  error:nil];
		}

		spoolFile = fopen(spoolPath.c_str(), "wb");
		if (spoolFile == nullptr) {
			throwSpoolError("TEXT_SPOOL_WRITE_FAILED", "Failed to create text spool file for " + bufferId);
		}
		spoolBytes = 0;
		appendSnapshotRecordLocked(bootstrapSnapshot);
	}

	void maybeWriteSnapshotToSpool(const std::string &snapshot, bool mayActivateAuto) {
		if (!spoolEnabled()) return;

		std::lock_guard<std::mutex> lock(spoolMutex);
		if (!spoolFailureCode.empty()) {
			throw makeCodedError(
				spoolFailureCode,
				spoolFailureMessage.empty() ? "Text spool is unavailable for " + bufferId : spoolFailureMessage
			);
		}
		if (spoolFile == nullptr) {
			switch (spoolingMode) {
				case SPOOL_OFF:
					return;
				case SPOOL_ON:
					ensureSpoolWriterActivatedLocked(snapshot);
					return;
				case SPOOL_AUTO: {
					if (!mayActivateAuto) return;
					spoolEstimatedBytes += (int64_t)(4 + snapshot.size());
					if (spoolEstimatedBytes < std::max<int64_t>(0, spoolThresholdBytes)) {
						spoolReady = false;
						return;
					}
					ensureSpoolWriterActivatedLocked(snapshot);
					return;
				}
			}
		}

		appendSnapshotRecordLocked(snapshot);
	}

	void configureSpooling(SpoolingMode mode,
						 const std::string &path,
						 bool temporary,
						 int64_t thresholdBytes) {
		spoolingMode = mode;
		spoolPath = path;
		spoolTemporary = temporary;
		spoolThresholdBytes = thresholdBytes;
		spoolReady = false;
		spoolBytes = 0;
		spoolEstimatedBytes = 0;
		spoolFailureCode.clear();
		spoolFailureMessage.clear();

		{
			std::lock_guard<std::mutex> lock(spoolMutex);
			closeSpoolFileLocked(false);
		}

		if (spoolingMode == SPOOL_ON) {
			std::string snapshot;
			{
				std::lock_guard<std::mutex> lock(stateMutex);
				snapshot = currentFullSnapshotLocked();
			}
			maybeWriteSnapshotToSpool(snapshot, true);
		}
	}

	void writePartial(const std::string &text) {
		std::lock_guard<std::mutex> lock(stateMutex);
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
		maybeWriteSnapshotToSpool(currentFullSnapshotLocked(), true);
	}

	void appendText(const std::string &text) {
		std::lock_guard<std::mutex> lock(stateMutex);
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
		maybeWriteSnapshotToSpool(currentFullSnapshotLocked(), true);
	}

	int commitSegment(const std::string &text,
					  const std::vector<std::string> &tokens = {},
					  const std::vector<float> &timestamps = {},
					  const std::string &source = "unknown",
					  NSDictionary *meta = nil) {
		int committedSegmentIndex = -1;
		{
			std::lock_guard<std::mutex> stateLock(stateMutex);
			if (state == FINISHED) {
				throw std::runtime_error("Live text buffer is finalized: " + bufferId);
			}
			{
				std::lock_guard<std::mutex> segmentLock(segmentMutex);
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
				maybeWriteSnapshotToSpool(committedTextFromSegmentsLocked() + currentText, true);
			}
		}
		notifyAppendListeners();
		return committedSegmentIndex;
	}

	void finalize_() {
		{
			std::lock_guard<std::mutex> lock(stateMutex);
			if (state == FINISHED) {
				throw std::runtime_error("Already finalized: " + bufferId);
			}
			state = FINISHED;
		}

		if (spoolEnabled()) {
			std::lock_guard<std::mutex> lock(spoolMutex);
			if (spoolFile != nullptr) {
				if (fflush(spoolFile) != 0) {
					throwSpoolError("TEXT_SPOOL_WRITE_FAILED", "Failed to finalize text spool for " + bufferId);
				}
				closeSpoolFileLocked(false);
			}
		}

		notifyAppendListeners();
	}

	std::string snapshotText() {
		std::lock_guard<std::mutex> lock(stateMutex);
		return currentText;
	}

	std::string snapshotFullTextIfSpooled() {
		if (!spoolEnabled()) {
			throw makeCodedError("TEXT_SPOOL_UNAVAILABLE", "Text spooling is disabled for " + bufferId);
		}
		std::string failureCode;
		std::string failureMessage;
		bool ready = false;
		std::string path;
		{
			std::lock_guard<std::mutex> lock(spoolMutex);
			failureCode = spoolFailureCode;
			failureMessage = spoolFailureMessage;
			ready = spoolReady;
			path = spoolPath;
			if (!failureCode.empty()) {
				throw makeCodedError(
					failureCode,
					failureMessage.empty() ? "Text spool is unavailable for " + bufferId : failureMessage
				);
			}
			if (!ready) {
				throw makeCodedError("TEXT_SPOOL_UNAVAILABLE", "Text spool is not ready for " + bufferId);
			}
			if (path.empty()) {
				throw makeCodedError("TEXT_SPOOL_UNAVAILABLE", "Text spool path is missing for " + bufferId);
			}
			if (spoolFile != nullptr) {
				fflush(spoolFile);
			}
		}

		FILE *reader = fopen(path.c_str(), "rb");
		if (reader == nullptr) {
			throw makeCodedError("TEXT_SPOOL_READ_FAILED", "Failed to open text spool for " + bufferId);
		}

		unsigned char header[4];
		size_t readHeader = fread(header, 1, 4, reader);
		if (readHeader != 4) {
			fclose(reader);
			throw makeCodedError("TEXT_SPOOL_CORRUPTED", "Corrupted text spool header for " + bufferId);
		}
		uint32_t len =
			(uint32_t)header[0] |
			((uint32_t)header[1] << 8) |
			((uint32_t)header[2] << 16) |
			((uint32_t)header[3] << 24);

		std::string payload;
		payload.resize(len);
		if (len > 0) {
			size_t readPayload = fread(payload.data(), 1, len, reader);
			if (readPayload != len) {
				fclose(reader);
				throw makeCodedError("TEXT_SPOOL_CORRUPTED", "Truncated text spool payload for " + bufferId);
			}
		}

		if (fgetc(reader) != EOF) {
			fclose(reader);
			throw makeCodedError("TEXT_SPOOL_CORRUPTED", "Unexpected trailing data in text spool for " + bufferId);
		}
		fclose(reader);
		return payload;
	}

	NSDictionary *toDict() {
		std::string stateValue;
		int64_t totalChars = 0;
		bool enabled = false;
		{
			std::lock_guard<std::mutex> lock(stateMutex);
			stateValue = state == RECORDING ? "recording" : "finished";
			totalChars = totalCharsWritten;
			enabled = spoolEnabled();
		}
		std::string spoolModeRaw;
		bool ready = false;
		int64_t bytes = 0;
		std::string path;
		{
			std::lock_guard<std::mutex> lock(spoolMutex);
			spoolModeRaw = spoolingModeRaw(spoolingMode);
			ready = spoolReady;
			bytes = spoolBytes;
			path = spoolPath;
		}
		NSMutableDictionary *dict = [@{
			@"bufferId": [NSString stringWithUTF8String:bufferId.c_str()],
			@"kind": @"liveTextBuffer",
			@"state": [NSString stringWithUTF8String:stateValue.c_str()],
			@"totalCharsWritten": @(totalChars),
			@"revision": @(revision.load()),
			@"segmentCount": @(segmentCount()),
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

	void release() {
		std::string pathToDelete;
		bool shouldDelete = false;
		{
			std::lock_guard<std::mutex> lock(spoolMutex);
			closeSpoolFileLocked(false);
			if (spoolTemporary && !spoolPath.empty()) {
				pathToDelete = spoolPath;
				shouldDelete = true;
			}
		}
		if (shouldDelete) {
			remove(pathToDelete.c_str());
		}
		{
			std::lock_guard<std::mutex> lock(cursorMutex);
			segmentCursors.clear();
		}
		{
			std::lock_guard<std::mutex> lock(appendListenerMutex);
			appendListeners.clear();
		}
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

// Release all text entries and cleanup any temporary spool files.
void txt_release_all_entries();
#endif
