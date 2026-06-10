package com.sherpaonnx.text.pipeline

import org.json.JSONObject

/**
 * Pure helpers for live-text spool checkpointing and `fullIfSpooled` replay.
 * Extracted for unit tests and shared Android replay semantics.
 */
internal object TextSpoolReplay {
  const val RECORD_PARTIAL_SET = 1
  const val RECORD_PARTIAL_APPEND = 2
  const val RECORD_SEGMENT_COMMIT = 3

  fun buildCheckpointPayload(
    fullText: String,
    totalCharsWritten: Long,
    revision: Int,
  ): String {
    val escaped = fullText.replace("\\", "\\\\").replace("\"", "\\\"")
    return """{"fullText":"$escaped","totalCharsWritten":$totalCharsWritten,"revision":$revision}"""
  }

  fun extractCheckpointText(payload: String): String {
    val marker = """"fullText":""""
    val idx = payload.indexOf(marker)
    if (idx < 0) return ""
    val start = payload.indexOf('"', idx + marker.length)
    if (start < 0) return ""
    val end = payload.indexOf('"', start + 1)
    if (end < 0) return ""
    return payload.substring(start + 1, end).replace("\\\"", "\"").replace("\\\\", "\\")
  }

  /**
   * Live partial window minus text already committed in the last segment.
   */
  fun partialRemainderFromCurrentText(
    currentText: String,
    lastCommittedSegmentText: String?,
  ): String {
    if (currentText.isEmpty()) return ""
    if (
      lastCommittedSegmentText != null &&
      currentText.startsWith(lastCommittedSegmentText)
    ) {
      return currentText.substring(lastCommittedSegmentText.length)
    }
    return currentText
  }

  fun snapshotFullText(
    committedSegmentText: String,
    currentText: String,
    lastCommittedSegmentText: String?,
  ): String {
    return committedSegmentText +
      partialRemainderFromCurrentText(currentText, lastCommittedSegmentText)
  }

  /**
   * Apply one journal record while replaying toward `fullIfSpooled` text.
   */
  fun applyJournalRecord(fullText: String, recordType: Int, payload: String): String {
    return when (recordType) {
      RECORD_PARTIAL_SET -> {
        if (payload.length >= fullText.length) {
          payload
        } else {
          fullText
        }
      }
      RECORD_PARTIAL_APPEND -> fullText + payload
      RECORD_SEGMENT_COMMIT -> {
        val obj = JSONObject(payload)
        fullText + obj.optString("text", "")
      }
      else -> fullText
    }
  }

  fun replayFullTextFromCheckpointAndJournal(
    checkpointPayload: String?,
    journal: List<TextSpoolJournalRecord>,
  ): String {
    var fullText = ""
    if (checkpointPayload != null) {
      fullText = extractCheckpointText(checkpointPayload)
    }
    journal.forEach { rec ->
      fullText = applyJournalRecord(fullText, rec.type, rec.payload)
    }
    return fullText
  }
}
