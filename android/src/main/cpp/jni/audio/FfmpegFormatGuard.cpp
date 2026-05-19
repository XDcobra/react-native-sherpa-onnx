/**
 * FfmpegFormatGuard — extension-to-demuxer checks aligned with minimal FFmpeg prebuilts.
 *
 * Demuxer list must stay in sync with:
 *   third_party/ffmpeg_prebuilt/build_ffmpeg.sh
 *   third_party/ffmpeg_prebuilt/build_ffmpeg_ios.sh
 */

#include "FfmpegFormatGuard.h"

#include <cctype>
#include <cstring>
#include <string>

#ifdef __ANDROID__
#include <android/log.h>
#define LOG_TAG "FfmpegFormatGuard"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, LOG_TAG, __VA_ARGS__)
#elif defined(__APPLE__)
#include <os/log.h>
#define LOGI(fmt, ...) os_log_info(OS_LOG_DEFAULT, fmt, ##__VA_ARGS__)
#define LOGW(fmt, ...) os_log(OS_LOG_DEFAULT, fmt, ##__VA_ARGS__)
#else
#define LOGI(...) ((void)0)
#define LOGW(...) ((void)0)
#endif

#ifdef HAVE_FFMPEG
extern "C" {
#include <libavformat/avformat.h>
#include <libavutil/error.h>
}
#endif

namespace sherpa {
namespace {

struct ExtensionDemuxerEntry {
  const char* extension;
  const char* demuxerShortName;
};

// Mirrors --enable-demuxer=mov,mp3,ogg,flac,wav,matroska,aac in build_ffmpeg*.sh
constexpr ExtensionDemuxerEntry kExtensionDemuxers[] = {
    {"wav", "wav"},
    {"mp3", "mp3"},
    {"mp2", "mp3"},
    {"flac", "flac"},
    {"m4a", "mov"},
    {"mp4", "mov"},
    {"mov", "mov"},
    {"3gp", "mov"},
    {"aac", "aac"},
    {"adts", "aac"},
    {"ogg", "ogg"},
    {"oga", "ogg"},
    {"opus", "ogg"},
    {"ogm", "ogg"},
    {"mkv", "matroska"},
    {"mka", "matroska"},
    {"webm", "matroska"},
};

std::string toLowerAscii(std::string s) {
  for (char& c : s) {
    c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  }
  return s;
}

std::string extractExtensionLower(const char* path) {
  if (!path || path[0] == '\0') {
    return {};
  }
  const char* slash = strrchr(path, '/');
  const char* base = slash ? slash + 1 : path;
  const char* dot = strrchr(base, '.');
  if (!dot || dot == base || dot[1] == '\0') {
    return {};
  }
  return toLowerAscii(dot + 1);
}

const ExtensionDemuxerEntry* lookupExtension(const std::string& ext) {
  if (ext.empty()) {
    return nullptr;
  }
  for (const auto& entry : kExtensionDemuxers) {
    if (ext == entry.extension) {
      return &entry;
    }
  }
  return nullptr;
}

#ifdef HAVE_FFMPEG

const AVInputFormat* findDemuxerByShortName(const char* shortName) {
  return shortName ? av_find_input_format(shortName) : nullptr;
}

void appendFfmpegError(std::string& msg, int err) {
  char errbuf[AV_ERROR_MAX_STRING_SIZE] = {0};
  av_strerror(err, errbuf, sizeof(errbuf));
  if (errbuf[0] != '\0') {
    msg += ": ";
    msg += errbuf;
  }
}

FfmpegFormatGuardResult makeFormatUnsupported(
    const char* errorPrefix,
    const char* path,
    const ExtensionDemuxerEntry& entry) {
  FfmpegFormatGuardResult result;
  result.ok = false;
  result.errorMessage = std::string(errorPrefix) + "_FORMAT_UNSUPPORTED: ." + entry.extension +
                        " requires FFmpeg demuxer \"" + entry.demuxerShortName +
                        "\" (not in this build). Rebuild prebuilts with --enable-demuxer=...,"
      + entry.demuxerShortName;
  if (path && path[0] != '\0') {
    result.errorMessage += " path=";
    result.errorMessage += path;
  }
  LOGW("%s", result.errorMessage.c_str());
  return result;
}

FfmpegFormatGuardResult makeOpenFailed(
    const char* errorPrefix,
    const char* path,
    const char* demuxerShortName,
    int err) {
  FfmpegFormatGuardResult result;
  result.ok = false;
  result.errorMessage = std::string(errorPrefix) + "_OPEN_FAILED: Cannot open";
  if (path && path[0] != '\0') {
    result.errorMessage += " file: ";
    result.errorMessage += path;
  } else {
    result.errorMessage += " input";
  }
  if (demuxerShortName && demuxerShortName[0] != '\0') {
    result.errorMessage += " (demuxer ";
    result.errorMessage += demuxerShortName;
    result.errorMessage += ")";
  }
  appendFfmpegError(result.errorMessage, err);
  LOGW("%s", result.errorMessage.c_str());
  return result;
}

bool tryOpenInput(
    AVFormatContext** fmtCtx,
    const char* path,
    const AVInputFormat* ifmt,
    int* outErr) {
  const int err = avformat_open_input(fmtCtx, path, ifmt, nullptr);
  if (outErr) {
    *outErr = err;
  }
  return err >= 0;
}

#endif // HAVE_FFMPEG

} // anonymous namespace

FfmpegFormatGuardResult checkPathFormatSupported(
    const char* path,
    const char* errorPrefix) {
  FfmpegFormatGuardResult result;
  result.ok = true;

#ifndef HAVE_FFMPEG
  result.ok = false;
  result.errorMessage = std::string(errorPrefix) + "_UNSUPPORTED: FFmpeg not available in this build";
  return result;
#else
  if (!errorPrefix || errorPrefix[0] == '\0') {
    errorPrefix = "FFMPEG";
  }

  const std::string ext = extractExtensionLower(path);
  const ExtensionDemuxerEntry* entry = lookupExtension(ext);
  if (!entry) {
    return result;
  }

  if (!findDemuxerByShortName(entry->demuxerShortName)) {
    return makeFormatUnsupported(errorPrefix, path, *entry);
  }

  return result;
#endif
}

FfmpegFormatGuardResult openGuardedFormatInput(
    AVFormatContext** fmtCtx,
    const char* path,
    const char* errorPrefix) {
#ifndef HAVE_FFMPEG
  FfmpegFormatGuardResult result;
  result.ok = false;
  result.errorMessage = std::string(errorPrefix ? errorPrefix : "FFMPEG") +
                        "_UNSUPPORTED: FFmpeg not available in this build";
  return result;
#else
  if (!errorPrefix || errorPrefix[0] == '\0') {
    errorPrefix = "FFMPEG";
  }
  if (!fmtCtx || !path || path[0] == '\0') {
    FfmpegFormatGuardResult result;
    result.ok = false;
    result.errorMessage = std::string(errorPrefix) + "_NOT_FOUND: Empty file path";
    return result;
  }

  FfmpegFormatGuardResult support = checkPathFormatSupported(path, errorPrefix);
  if (!support.ok) {
    return support;
  }

  const std::string ext = extractExtensionLower(path);
  const ExtensionDemuxerEntry* entry = lookupExtension(ext);

  int err = 0;
  if (entry) {
    const AVInputFormat* demuxer = findDemuxerByShortName(entry->demuxerShortName);
    if (demuxer && tryOpenInput(fmtCtx, path, demuxer, &err)) {
      LOGI("opened %s with demuxer %s", path, entry->demuxerShortName);
      FfmpegFormatGuardResult result;
      result.ok = true;
      return result;
    }
    if (demuxer) {
      LOGW("explicit demuxer %s failed for %s, trying auto-probe", entry->demuxerShortName, path);
    }
  }

  if (tryOpenInput(fmtCtx, path, nullptr, &err)) {
    FfmpegFormatGuardResult result;
    result.ok = true;
    return result;
  }

  const char* demuxerName = entry ? entry->demuxerShortName : nullptr;
  return makeOpenFailed(errorPrefix, path, demuxerName, err);
#endif
}

FfmpegFormatGuardResult openGuardedFdFormatInput(
    AVFormatContext** fmtCtx,
    const char* pathHint,
    const char* errorPrefix) {
#ifndef HAVE_FFMPEG
  FfmpegFormatGuardResult result;
  result.ok = false;
  result.errorMessage = std::string(errorPrefix ? errorPrefix : "FFMPEG") +
                        "_UNSUPPORTED: FFmpeg not available in this build";
  return result;
#else
  if (!errorPrefix || errorPrefix[0] == '\0') {
    errorPrefix = "FFMPEG";
  }
  if (!fmtCtx || !*fmtCtx) {
    FfmpegFormatGuardResult result;
    result.ok = false;
    result.errorMessage = std::string(errorPrefix) + "_INTERNAL_ERROR: Missing format context";
    return result;
  }

  if (pathHint && pathHint[0] != '\0') {
    FfmpegFormatGuardResult support = checkPathFormatSupported(pathHint, errorPrefix);
    if (!support.ok) {
      return support;
    }
  }

  const std::string ext = extractExtensionLower(pathHint);
  const ExtensionDemuxerEntry* entry = lookupExtension(ext);

  int err = 0;
  if (entry) {
    const AVInputFormat* demuxer = findDemuxerByShortName(entry->demuxerShortName);
    if (demuxer && tryOpenInput(fmtCtx, nullptr, demuxer, &err)) {
      LOGI("opened fd input with demuxer %s", entry->demuxerShortName);
      FfmpegFormatGuardResult result;
      result.ok = true;
      return result;
    }
  }

  if (tryOpenInput(fmtCtx, nullptr, nullptr, &err)) {
    FfmpegFormatGuardResult result;
    result.ok = true;
    return result;
  }

  const char* demuxerName = entry ? entry->demuxerShortName : nullptr;
  return makeOpenFailed(errorPrefix, pathHint, demuxerName, err);
#endif
}

} // namespace sherpa
