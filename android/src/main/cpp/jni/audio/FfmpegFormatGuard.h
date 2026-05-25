#pragma once

#include <string>

struct AVFormatContext;
struct AVInputFormat;

namespace sherpa {

/**
 * Result of a format-support check or guarded avformat_open_input.
 * errorMessage is ready to pass to std::runtime_error (includes PROBE_* / DECODE_* prefix).
 */
struct FfmpegFormatGuardResult {
  bool ok = false;
  std::string errorMessage;
};

/**
 * Check whether FFmpeg in this build can demux the file at path (by extension).
 * Unknown extensions return ok=true (caller may still try auto-probe).
 *
 * @param errorPrefix e.g. "PROBE" or "DECODE" — used in error codes.
 */
FfmpegFormatGuardResult checkPathFormatSupported(
    const char* path,
    const char* errorPrefix);

/**
 * Open an input from a filesystem path using guarded demuxer selection.
 * Fails fast when a known extension's demuxer is missing from the build.
 *
 * @param errorPrefix e.g. "PROBE" or "DECODE"
 */
FfmpegFormatGuardResult openGuardedFormatInput(
    AVFormatContext** fmtCtx,
    const char* path,
    const char* errorPrefix,
    bool allowDemuxerAutoProbe = true);

/**
 * Open an input from a custom AVIO context (fd). fmtCtx->pb must already be set.
 * When path is non-null, known extensions are checked the same way as path open.
 *
 * @param errorPrefix e.g. "PROBE" or "DECODE"
 */
FfmpegFormatGuardResult openGuardedFdFormatInput(
    AVFormatContext** fmtCtx,
    const char* pathHint,
    const char* errorPrefix,
    bool allowDemuxerAutoProbe = true);

} // namespace sherpa
