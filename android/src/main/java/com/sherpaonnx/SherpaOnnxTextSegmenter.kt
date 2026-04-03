package com.sherpaonnx

import kotlin.math.floor
import kotlin.math.max

internal data class SubtitleTimingItem(
  val text: String,
  val start: Double,
  val end: Double
)

internal object SherpaOnnxTextSegmenter {
  private val sentenceTerminators = setOf('.', '!', '?', ';', '。', '！', '？', '；')
  private val trailingClosers = setOf('"', '\'', ')', ']', '}', '>', '”', '’', '」', '』', '】', '）')
  private val commonAbbreviations = setOf(
    "mr",
    "mrs",
    "ms",
    "dr",
    "prof",
    "sr",
    "jr",
    "st",
    "vs",
    "etc",
    "e.g",
    "i.e"
  )

  fun splitIntoSentences(text: String): List<String> {
    val normalized = text.trim()
    if (normalized.isEmpty()) return emptyList()

    val out = mutableListOf<String>()
    var start = 0
    var i = 0

    while (i < normalized.length) {
      val current = normalized[i]
      if (!isSentenceTerminator(current)) {
        i += 1
        continue
      }

      if (current == '.' && !shouldSplitOnPeriod(normalized, i)) {
        i += 1
        continue
      }

      val end = sentenceBoundaryEnd(normalized, i)
      val next = normalized.getOrNull(end)
      if (next != null && !next.isWhitespace()) {
        i += 1
        continue
      }

      val sentence = normalized.substring(start, end).trim()
      if (sentence.isNotEmpty()) {
        out += sentence
      }

      start = end
      while (start < normalized.length && normalized[start].isWhitespace()) {
        start += 1
      }
      i = start
    }

    val tail = if (start < normalized.length) normalized.substring(start).trim() else ""
    if (tail.isNotEmpty()) {
      out += tail
    }

    return if (out.isNotEmpty()) out else listOf(normalized)
  }

  fun splitIntoWords(text: String): List<String> {
    val normalized = text.trim()
    if (normalized.isEmpty()) return emptyList()

    val out = mutableListOf<String>()
    val current = StringBuilder()

    fun flushCurrent() {
      val token = current.toString().trim()
      if (token.isNotEmpty()) {
        out += token
      }
      current.clear()
    }

    for (char in normalized) {
      when {
        char.isWhitespace() -> flushCurrent()
        isCjkChar(char) -> {
          flushCurrent()
          out += char.toString()
        }
        isWordDelimiter(char) -> flushCurrent()
        else -> current.append(char)
      }
    }

    flushCurrent()
    return if (out.isNotEmpty()) out else listOf(normalized)
  }

  fun buildSubtitlesFromChunks(
    segments: List<String>,
    chunkSampleCounts: List<Int>,
    sampleRate: Int
  ): List<SubtitleTimingItem> {
    if (sampleRate <= 0) return emptyList()

    val cleanedSegments = sanitizeSegments(segments)
    if (cleanedSegments.isEmpty()) return emptyList()

    val alignedCounts = alignChunkCountsToSegments(cleanedSegments, chunkSampleCounts)

    val subtitles = mutableListOf<SubtitleTimingItem>()
    var offsetSamples = 0

    for (index in cleanedSegments.indices) {
      val samples = alignedCounts.getOrElse(index) { 0 }.coerceAtLeast(0)
      if (samples == 0 && offsetSamples == 0) {
        continue
      }

      val startSec = offsetSamples.toDouble() / sampleRate.toDouble()
      offsetSamples += samples
      val endSec = offsetSamples.toDouble() / sampleRate.toDouble()

      subtitles += SubtitleTimingItem(
        text = cleanedSegments[index],
        start = startSec,
        end = endSec
      )
    }

    return subtitles
  }

  fun buildWordSubtitlesFromSentenceChunks(
    sentences: List<String>,
    sentenceChunkSampleCounts: List<Int>,
    sampleRate: Int
  ): List<SubtitleTimingItem> {
    val cleanedSentences = sanitizeSegments(sentences)
    if (cleanedSentences.isEmpty()) return emptyList()

    val alignedSentenceCounts = alignChunkCountsToSegments(
      cleanedSentences,
      sentenceChunkSampleCounts
    )

    val wordSegments = mutableListOf<String>()
    val wordChunkCounts = mutableListOf<Int>()

    for (index in cleanedSentences.indices) {
      val sentence = cleanedSentences[index]
      val sentenceSamples = alignedSentenceCounts.getOrElse(index) { 0 }.coerceAtLeast(0)
      val words = splitIntoWords(sentence)
      if (words.isEmpty()) continue

      val distributed = distributeSamplesByTextWeight(sentenceSamples, words)
      for (wordIndex in words.indices) {
        wordSegments += words[wordIndex]
        wordChunkCounts += distributed.getOrElse(wordIndex) { 0 }
      }
    }

    return buildSubtitlesFromChunks(wordSegments, wordChunkCounts, sampleRate)
  }

  private fun sanitizeSegments(segments: List<String>): List<String> {
    return segments
      .map { it.trim() }
      .filter { it.isNotEmpty() }
  }

  private fun alignChunkCountsToSegments(
    segments: List<String>,
    chunkSampleCounts: List<Int>
  ): List<Int> {
    if (segments.isEmpty()) return emptyList()

    val counts = chunkSampleCounts.map { max(0, it) }
    if (counts.size == segments.size) {
      return counts
    }

    if (counts.size > segments.size) {
      val merged = counts.take(segments.size).toMutableList()
      val extra = counts.drop(segments.size).sum()
      if (merged.isNotEmpty()) {
        val lastIndex = merged.lastIndex
        merged[lastIndex] = merged[lastIndex] + extra
      }
      return merged
    }

    return distributeSamplesByTextWeight(counts.sum(), segments)
  }

  private fun distributeSamplesByTextWeight(totalSamples: Int, segments: List<String>): List<Int> {
    if (segments.isEmpty()) return emptyList()

    val safeTotal = totalSamples.coerceAtLeast(0)
    if (safeTotal == 0) {
      return List(segments.size) { 0 }
    }

    val weights = segments.map { max(1, it.length) }
    val weightSum = weights.sum().coerceAtLeast(1)

    val base = MutableList(segments.size) { 0 }
    val fractions = mutableListOf<Pair<Int, Double>>()

    for (index in segments.indices) {
      val exact = (safeTotal.toDouble() * weights[index].toDouble()) / weightSum.toDouble()
      val floorValue = floor(exact).toInt()
      base[index] = floorValue
      fractions += index to (exact - floorValue.toDouble())
    }

    var assigned = base.sum()
    var remaining = safeTotal - assigned

    if (remaining > 0) {
      val order = fractions.sortedByDescending { it.second }
      var ptr = 0
      while (remaining > 0 && order.isNotEmpty()) {
        val target = order[ptr % order.size].first
        base[target] = base[target] + 1
        assigned += 1
        remaining = safeTotal - assigned
        ptr += 1
      }
    }

    return base
  }

  private fun isSentenceTerminator(char: Char): Boolean {
    return sentenceTerminators.contains(char)
  }

  private fun shouldSplitOnPeriod(text: String, periodIndex: Int): Boolean {
    val prev = text.getOrNull(periodIndex - 1)
    val next = text.getOrNull(periodIndex + 1)

    if (prev != null && next != null && prev.isDigit() && next.isDigit()) {
      return false
    }

    val tokenRaw = extractTokenBeforePeriod(text, periodIndex)
    val tokenLower = tokenRaw.lowercase()
    if (commonAbbreviations.contains(tokenLower)) {
      return false
    }

    // Likely initial, e.g. "A. Smith" — use original case; tokenLower[0] is never uppercase.
    if (tokenRaw.length == 1 && tokenRaw[0].isUpperCase()) {
      return false
    }

    return true
  }

  private fun extractTokenBeforePeriod(text: String, periodIndex: Int): String {
    var i = periodIndex - 1
    while (i >= 0 && text[i].isWhitespace()) {
      i -= 1
    }

    val end = i
    while (i >= 0) {
      val c = text[i]
      if (c.isLetter() || c == '.') {
        i -= 1
        continue
      }
      break
    }

    if (end < i + 1) return ""

    var token = text.substring(i + 1, end + 1)
    while (token.endsWith('.')) {
      token = token.dropLast(1)
    }
    return token
  }

  private fun sentenceBoundaryEnd(text: String, startIndex: Int): Int {
    var end = startIndex + 1
    while (end < text.length && isSentenceTerminator(text[end])) {
      end += 1
    }
    while (end < text.length && trailingClosers.contains(text[end])) {
      end += 1
    }
    return end
  }

  private fun isCjkChar(char: Char): Boolean {
    val block = Character.UnicodeBlock.of(char)
    return block == Character.UnicodeBlock.CJK_UNIFIED_IDEOGRAPHS ||
      block == Character.UnicodeBlock.CJK_UNIFIED_IDEOGRAPHS_EXTENSION_A ||
      block == Character.UnicodeBlock.CJK_UNIFIED_IDEOGRAPHS_EXTENSION_B ||
      block == Character.UnicodeBlock.CJK_UNIFIED_IDEOGRAPHS_EXTENSION_C ||
      block == Character.UnicodeBlock.CJK_UNIFIED_IDEOGRAPHS_EXTENSION_D ||
      block == Character.UnicodeBlock.CJK_UNIFIED_IDEOGRAPHS_EXTENSION_E ||
      block == Character.UnicodeBlock.CJK_UNIFIED_IDEOGRAPHS_EXTENSION_F ||
      block == Character.UnicodeBlock.CJK_UNIFIED_IDEOGRAPHS_EXTENSION_G ||
      block == Character.UnicodeBlock.HIRAGANA ||
      block == Character.UnicodeBlock.KATAKANA ||
      block == Character.UnicodeBlock.HANGUL_SYLLABLES
  }

  private fun isWordDelimiter(char: Char): Boolean {
    return when (char) {
      '.', ',', '!', '?', ';', ':', '(', ')', '[', ']', '{', '}',
      '"', '\'', '`', '~', '<', '>', '/', '\\', '|', '@', '#', '$',
      '%', '^', '&', '*', '+', '=', '…', '，', '。', '！', '？', '；',
      '：', '、' -> true
      else -> false
    }
  }
}
