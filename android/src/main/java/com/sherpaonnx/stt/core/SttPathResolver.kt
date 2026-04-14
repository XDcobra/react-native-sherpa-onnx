package com.sherpaonnx.stt.core

import android.content.Context
import android.net.Uri
import java.io.File

internal class SttPathResolver(private val context: Context) {

  fun resolveContentUriToFile(path: String, cacheFilePrefix: String): String {
    if (!path.startsWith("content://")) return path
    val uri = Uri.parse(path)
    val cacheFile = File(context.cacheDir, "${cacheFilePrefix}_${System.nanoTime()}")
    try {
      context.contentResolver.openInputStream(uri)?.use { input ->
        cacheFile.outputStream().use { output ->
          input.copyTo(output)
        }
      } ?: throw IllegalStateException("File is not readable (content URI could not be opened): $path")
    } catch (e: SecurityException) {
      throw IllegalStateException("File is not readable (no permission to read content URI): $path", e)
    } catch (e: Exception) {
      if (e is IllegalStateException) throw e
      throw IllegalStateException("File is not readable (content URI could not be opened): ${e.message ?: path}", e)
    }
    return cacheFile.absolutePath
  }

  fun resolveFilePaths(pathsString: String, cacheFilePrefix: String): String {
    if (pathsString.isBlank()) return pathsString
    return pathsString.split(',').map { it.trim() }.filter { it.isNotEmpty() }
      .mapIndexed { index, p -> resolveContentUriToFile(p, "${cacheFilePrefix}_$index") }
      .joinToString(",")
  }

  fun resolveHotwordsPath(path: String): String =
    resolveContentUriToFile(path, "stt_hotwords")

  fun validateHotwordsFile(filePath: String): String? {
    val file = File(filePath)
    if (!file.exists()) return "Hotwords file does not exist: $filePath"
    if (!file.isFile) return "Hotwords path is not a file: $filePath"
    if (!file.canRead()) return "Hotwords file is not readable: $filePath"
    val content = try {
      file.readText(Charsets.UTF_8)
    } catch (e: Exception) {
      return "Failed to read hotwords file: ${e.message}"
    }
    if (content.contains('\u0000')) return "Hotwords file contains null bytes (not a valid text file)."
    val lines = content.split('\n', '\r')
    var validLines = 0
    for (raw in lines) {
      val line = raw.trim()
      if (line.isEmpty()) continue
      val hotwordPart = if (line.contains(" :")) {
        val lastColon = line.lastIndexOf(" :")
        val afterScore = line.substring(lastColon + 2).trim()
        if (afterScore.isEmpty()) return "Invalid hotword line (missing score after ' :'): ${line.take(60)}..."
        val score = afterScore.toFloatOrNull()
        if (score == null) return "Invalid hotword line (score must be a number after ' :'): ${line.take(60)}..."
        line.substring(0, lastColon).trim()
      } else if (line.contains('\t')) {
        val afterTab = line.substringAfter('\t').trim()
        if (afterTab.toFloatOrNull() != null) {
          return "This file looks like a sentencepiece .vocab file (token<TAB>score). Use a hotwords file instead: one word or phrase per line, optional ' :score' at end."
        }
        line
      } else line
      if (hotwordPart.isEmpty()) return "Invalid hotword line (empty hotword): ${line.take(60)}..."
      if (!hotwordPart.any { it.isLetter() }) return "Invalid hotword line (must contain at least one letter): ${line.take(60)}..."
      validLines++
    }
    if (validLines == 0) return "Hotwords file has no valid lines (one hotword or phrase per line, UTF-8 text)."
    return null
  }
}
