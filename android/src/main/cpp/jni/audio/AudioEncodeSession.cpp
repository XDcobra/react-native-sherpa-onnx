/**
 * AudioEncodeSession.cpp — Streaming audio encoder with WAV fast-path.
 *
 * FFmpeg path: float32 PCM → SwrContext → encoder → muxer (same logic as
 * the original audio_pcm_to_format.cpp, restructured into a session API).
 *
 * WAV fast-path: float32 → S16LE inline conversion → direct fwrite,
 * bypassing all avcodec/avformat overhead. Optional SwrContext only for
 * sample rate conversion.
 */

#include "AudioEncodeSession.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <vector>
#include <sys/stat.h>

#define LOG_TAG "AudioEncSess"
#ifdef __ANDROID__
#include <android/log.h>
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)
#else
#define LOGI(...) ((void)0)
#define LOGW(...) ((void)0)
#define LOGE(...) ((void)0)
#endif

#ifdef HAVE_FFMPEG
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/opt.h>
#include <libavutil/error.h>
#include <libavutil/channel_layout.h>
#include <libswresample/swresample.h>
}
#endif

namespace sherpa {

// ---------------------------------------------------------------------------
// Quality → bitrate table (kbps)
// ---------------------------------------------------------------------------
static int qualityToBitrateKbps(const char* fmt, int quality) {
    if (quality <= 0) return 0;
    // quality: 1=low, 2=medium, 3=high
    std::string f(fmt ? fmt : "");
    if (f == "mp3") {
        static const int table[] = {0, 64, 128, 192};
        return table[std::min(quality, 3)];
    }
    if (f == "aac" || f == "m4a") {
        static const int table[] = {0, 64, 128, 192};
        return table[std::min(quality, 3)];
    }
    if (f == "opus" || f == "ogg" || f == "webm" || f == "mkv") {
        static const int table[] = {0, 24, 64, 128};
        return table[std::min(quality, 3)];
    }
    return 0;
}

// ---------------------------------------------------------------------------
// WAV helpers
// ---------------------------------------------------------------------------
static inline int16_t floatToS16(float s) {
    float clamped = s < -1.0f ? -1.0f : (s > 1.0f ? 1.0f : s);
    return static_cast<int16_t>(clamped * 32767.0f);
}

static void writeU32LE(uint8_t* p, uint32_t v) {
    p[0] = (uint8_t)(v);
    p[1] = (uint8_t)(v >> 8);
    p[2] = (uint8_t)(v >> 16);
    p[3] = (uint8_t)(v >> 24);
}

static void writeU16LE(uint8_t* p, uint16_t v) {
    p[0] = (uint8_t)(v);
    p[1] = (uint8_t)(v >> 8);
}

// ---------------------------------------------------------------------------
// Impl
// ---------------------------------------------------------------------------
struct AudioEncodeSession::Impl {
    bool isWavFastPath = false;
    int inputSampleRate = 0;
    int outputSampleRate = 0;
    int inputChannelCount = 1;
    int64_t totalFramesFed = 0;
    int64_t totalFramesEstimate_ = 0;
    EncodeProgressCallback onProgress_;
    std::atomic<bool>& cancelFlag_;

    // WAV fast-path
    FILE* wavFile = nullptr;
    int64_t wavDataBytesWritten = 0;
    bool wavNeedsResample = false;
#ifdef HAVE_FFMPEG
    SwrContext* wavSwr = nullptr;
#endif
    std::vector<int16_t> wavConvertBuf;

    // FFmpeg path
#ifdef HAVE_FFMPEG
    AVFormatContext* outFmt = nullptr;
    AVCodecContext* encCtx = nullptr;
    AVStream* outStream = nullptr;
    SwrContext* swr = nullptr;
    std::vector<uint8_t> accumBuf;
    size_t accumReadOffset = 0;
    int accumSamples = 0;
    int encFrameSize = 0;
    int bytesPerFrame = 0;
    int outChannels = 1;
    int64_t encoderPts = 0;
#endif

    bool finished = false;

    explicit Impl(std::atomic<bool>& cf) : cancelFlag_(cf) {}
    ~Impl() { cleanup(); }

    void cleanup() {
        if (wavFile) {
            fclose(wavFile);
            wavFile = nullptr;
        }
#ifdef HAVE_FFMPEG
        if (wavSwr) { swr_free(&wavSwr); wavSwr = nullptr; }
        if (swr) { swr_free(&swr); swr = nullptr; }
        if (encCtx) { avcodec_free_context(&encCtx); encCtx = nullptr; }
        if (outFmt) {
            if (!(outFmt->oformat->flags & AVFMT_NOFILE) && outFmt->pb)
                avio_closep(&outFmt->pb);
            avformat_free_context(outFmt);
            outFmt = nullptr;
        }
#endif
    }

    void emitProgress() {
        if (!onProgress_) return;
        int pct = 0;
        if (totalFramesEstimate_ > 0) {
            pct = static_cast<int>(
                std::min<int64_t>(100, totalFramesFed * 100 / totalFramesEstimate_));
        }
        onProgress_(totalFramesFed, totalFramesEstimate_, pct);
    }

#ifdef HAVE_FFMPEG
    static constexpr size_t kCompactThreshold = 256 * 1024;

    void maybeCompact() {
        if (accumReadOffset == 0) return;
        if (accumReadOffset < kCompactThreshold && accumReadOffset * 2 < accumBuf.size()) return;
        size_t valid = accumBuf.size() - accumReadOffset;
        if (valid > 0)
            memmove(accumBuf.data(), accumBuf.data() + accumReadOffset, valid);
        accumBuf.resize(valid);
        accumReadOffset = 0;
    }

    void flushAccumFrames(bool sendPartial) {
        int needed = encFrameSize;
        if (needed <= 0) return;
        while (accumSamples >= needed || (sendPartial && accumSamples > 0)) {
            int toSend = (accumSamples >= needed) ? needed : accumSamples;
            AVFrame* ef = av_frame_alloc();
            if (!ef) break;
            ef->format = encCtx->sample_fmt;
            ef->sample_rate = encCtx->sample_rate;
            if (av_channel_layout_copy(&ef->ch_layout, &encCtx->ch_layout) < 0) {
                av_frame_free(&ef);
                break;
            }
            ef->nb_samples = toSend;
            if (av_frame_get_buffer(ef, 0) < 0) {
                av_channel_layout_uninit(&ef->ch_layout);
                av_frame_free(&ef);
                break;
            }
            int copyBytes = toSend * bytesPerFrame;
            memcpy(ef->data[0], accumBuf.data() + accumReadOffset, copyBytes);
            ef->pts = encoderPts;
            encoderPts += toSend;
            accumReadOffset += (size_t)copyBytes;
            accumSamples -= toSend;

            for (;;) {
                int r = avcodec_send_frame(encCtx, ef);
                if (r == 0) break;
                if (r == AVERROR(EAGAIN)) {
                    AVPacket* op = av_packet_alloc();
                    while (avcodec_receive_packet(encCtx, op) == 0) {
                        op->stream_index = outStream->index;
                        av_packet_rescale_ts(op, encCtx->time_base, outStream->time_base);
                        av_interleaved_write_frame(outFmt, op);
                        av_packet_unref(op);
                    }
                    av_packet_free(&op);
                    continue;
                }
                break;
            }
            AVPacket* op = av_packet_alloc();
            while (avcodec_receive_packet(encCtx, op) == 0) {
                op->stream_index = outStream->index;
                av_packet_rescale_ts(op, encCtx->time_base, outStream->time_base);
                av_interleaved_write_frame(outFmt, op);
                av_packet_unref(op);
            }
            av_packet_free(&op);
            av_channel_layout_uninit(&ef->ch_layout);
            av_frame_free(&ef);
            if (!sendPartial && accumSamples < needed) break;
        }
    }
#endif
};

// ---------------------------------------------------------------------------
// Construction / destruction
// ---------------------------------------------------------------------------
AudioEncodeSession::AudioEncodeSession() = default;
AudioEncodeSession::~AudioEncodeSession() = default;

int64_t AudioEncodeSession::framesEncoded() const {
    return impl_ ? impl_->totalFramesFed : 0;
}

// ---------------------------------------------------------------------------
// create()
// ---------------------------------------------------------------------------
std::unique_ptr<AudioEncodeSession> AudioEncodeSession::create(
    const AudioEncodeConfig& config,
    int64_t totalFramesEstimate,
    EncodeProgressCallback onProgress,
    std::atomic<bool>& cancelFlag,
    std::string& errorOut)
{
    if (!config.outputPath || !config.outputPath[0]) {
        errorOut = "ENCODE_NO_OUTPUT_PATH: No output path";
        return nullptr;
    }
    if (config.inputSampleRate <= 0) {
        errorOut = "ENCODE_INVALID_SAMPLE_RATE: Invalid input sample rate";
        return nullptr;
    }
    if (config.inputChannelCount <= 0) {
        errorOut = "ENCODE_INVALID_CHANNEL_COUNT: Invalid input channel count";
        return nullptr;
    }

    std::string fmt(config.formatHint ? config.formatHint : "");
    bool isWav = (fmt == "wav" || fmt.empty());

    auto session = std::unique_ptr<AudioEncodeSession>(new AudioEncodeSession());
    session->impl_ = std::make_unique<Impl>(cancelFlag);
    auto* d = session->impl_.get();

    d->inputSampleRate = config.inputSampleRate;
    d->inputChannelCount = config.inputChannelCount;
    d->totalFramesEstimate_ = totalFramesEstimate;
    d->onProgress_ = std::move(onProgress);

    // Resolve bitrate from explicit value or quality table
    int resolvedBitrateKbps = config.bitrate;
    if (resolvedBitrateKbps <= 0) {
        resolvedBitrateKbps = qualityToBitrateKbps(config.formatHint, config.quality);
    }

    // ----- WAV fast-path -----
    if (isWav) {
        d->isWavFastPath = true;
        d->outputSampleRate = (config.outputSampleRateHz > 0)
            ? config.outputSampleRateHz
            : config.inputSampleRate;
        d->wavNeedsResample = (d->outputSampleRate != config.inputSampleRate);

        d->wavFile = fopen(config.outputPath, "wb");
        if (!d->wavFile) {
            errorOut = "ENCODE_FILE_OPEN_FAILED: Cannot open output file for writing";
            return nullptr;
        }

        // Write provisional 44-byte RIFF/WAV header
        uint8_t header[44] = {};
        memcpy(header, "RIFF", 4);
        writeU32LE(header + 4, 0xFFFFFFFFu); // placeholder total size
        memcpy(header + 8, "WAVE", 4);
        memcpy(header + 12, "fmt ", 4);
        writeU32LE(header + 16, 16);         // fmt chunk size
        writeU16LE(header + 20, 1);          // PCM format
        int outCh = d->inputChannelCount;
        writeU16LE(header + 22, (uint16_t)outCh);
        writeU32LE(header + 24, (uint32_t)d->outputSampleRate);
        int bytesPerSample = 2; // S16LE
        writeU32LE(header + 28, (uint32_t)(d->outputSampleRate * outCh * bytesPerSample));
        writeU16LE(header + 32, (uint16_t)(outCh * bytesPerSample));
        writeU16LE(header + 34, 16);         // bits per sample
        memcpy(header + 36, "data", 4);
        writeU32LE(header + 40, 0xFFFFFFFFu); // placeholder data size

        if (fwrite(header, 1, 44, d->wavFile) != 44) {
            fclose(d->wavFile);
            d->wavFile = nullptr;
            errorOut = "ENCODE_FILE_WRITE_FAILED: Failed to write WAV header";
            return nullptr;
        }

#ifdef HAVE_FFMPEG
        // Set up SwrContext only if resampling is needed
        if (d->wavNeedsResample) {
            AVChannelLayout inLayout{}, outLayout{};
            av_channel_layout_default(&inLayout, d->inputChannelCount);
            av_channel_layout_default(&outLayout, d->inputChannelCount);

            if (swr_alloc_set_opts2(&d->wavSwr,
                    &outLayout, AV_SAMPLE_FMT_S16, d->outputSampleRate,
                    &inLayout, AV_SAMPLE_FMT_FLT, d->inputSampleRate,
                    0, nullptr) < 0 || !d->wavSwr) {
                av_channel_layout_uninit(&inLayout);
                av_channel_layout_uninit(&outLayout);
                fclose(d->wavFile);
                d->wavFile = nullptr;
                errorOut = "ENCODE_RESAMPLE_INIT_FAILED: Failed to initialize WAV resampler";
                return nullptr;
            }
            av_channel_layout_uninit(&inLayout);
            av_channel_layout_uninit(&outLayout);
            if (swr_init(d->wavSwr) < 0) {
                swr_free(&d->wavSwr);
                d->wavSwr = nullptr;
                fclose(d->wavFile);
                d->wavFile = nullptr;
                errorOut = "ENCODE_RESAMPLE_INIT_FAILED: swr_init failed for WAV";
                return nullptr;
            }
        }
#else
        if (d->wavNeedsResample) {
            fclose(d->wavFile);
            d->wavFile = nullptr;
            errorOut = "ENCODE_RESAMPLE_UNAVAILABLE: FFmpeg required for WAV resampling";
            return nullptr;
        }
#endif
        LOGI("AudioEncodeSession: WAV fast-path, outRate=%d, resample=%d",
             d->outputSampleRate, d->wavNeedsResample ? 1 : 0);
        return session;
    }

    // ----- FFmpeg path -----
#ifdef HAVE_FFMPEG
    d->isWavFastPath = false;

    AVCodecID codec_id = AV_CODEC_ID_NONE;
    if (fmt == "mp3") codec_id = AV_CODEC_ID_MP3;
    else if (fmt == "flac") codec_id = AV_CODEC_ID_FLAC;
    else if (fmt == "m4a" || fmt == "aac") codec_id = AV_CODEC_ID_AAC;
    else if (fmt == "opus" || fmt == "ogg" || fmt == "webm" || fmt == "mkv") codec_id = AV_CODEC_ID_OPUS;
    else codec_id = AV_CODEC_ID_PCM_S16LE;

    // Output context
    if (avformat_alloc_output_context2(&d->outFmt, nullptr, nullptr, config.outputPath) < 0 || !d->outFmt) {
        errorOut = "ENCODE_FORMAT_INIT_FAILED: Failed to allocate output context";
        return nullptr;
    }

    // Encoder selection
    const AVCodec* encoder = nullptr;
    if (codec_id == AV_CODEC_ID_MP3) {
        encoder = avcodec_find_encoder_by_name("libshine");
        if (!encoder) { errorOut = "ENCODE_CODEC_NOT_FOUND: libshine encoder not available"; d->cleanup(); return nullptr; }
    } else if (codec_id == AV_CODEC_ID_OPUS) {
        encoder = avcodec_find_encoder_by_name("libopus");
        if (!encoder) { errorOut = "ENCODE_CODEC_NOT_FOUND: libopus encoder not available"; d->cleanup(); return nullptr; }
    } else {
        encoder = avcodec_find_encoder(codec_id);
        if (!encoder) { errorOut = "ENCODE_CODEC_NOT_FOUND: Requested encoder not available"; d->cleanup(); return nullptr; }
    }

    d->outStream = avformat_new_stream(d->outFmt, nullptr);
    if (!d->outStream) { errorOut = "ENCODE_FORMAT_INIT_FAILED: Failed to create output stream"; d->cleanup(); return nullptr; }

    d->encCtx = avcodec_alloc_context3(encoder);
    if (!d->encCtx) { errorOut = "ENCODE_CODEC_INIT_FAILED: Failed to allocate encoder context"; d->cleanup(); return nullptr; }

    // Channel layout
    av_channel_layout_default(&d->encCtx->ch_layout, config.inputChannelCount);

    if (codec_id == AV_CODEC_ID_MP3) {
        int want_ch = (config.inputChannelCount == 2) ? 2 : 1;
        av_channel_layout_uninit(&d->encCtx->ch_layout);
        if (want_ch == 2) {
            AVChannelLayout stereo = AV_CHANNEL_LAYOUT_STEREO;
            if (av_channel_layout_copy(&d->encCtx->ch_layout, &stereo) < 0)
                av_channel_layout_default(&d->encCtx->ch_layout, 2);
        } else {
            AVChannelLayout mono = AV_CHANNEL_LAYOUT_MONO;
            if (av_channel_layout_copy(&d->encCtx->ch_layout, &mono) < 0)
                av_channel_layout_default(&d->encCtx->ch_layout, 1);
        }
    }

    // Sample rate
    d->encCtx->sample_rate = config.inputSampleRate;

    // Probe encoder capabilities
    AVSampleFormat chosen_fmt = AV_SAMPLE_FMT_NONE;
    const void *fmt_configs = nullptr;
    int fmt_num = 0;
    const void *sr_configs = nullptr;
    int sr_num = 0;
    const void *chl_configs = nullptr;
    int chl_num = 0;
#if defined(AV_CODEC_CONFIG_SAMPLE_FORMAT)
    avcodec_get_supported_config(d->encCtx, encoder, AV_CODEC_CONFIG_SAMPLE_FORMAT, 0, &fmt_configs, &fmt_num);
    avcodec_get_supported_config(d->encCtx, encoder, AV_CODEC_CONFIG_SAMPLE_RATE, 0, &sr_configs, &sr_num);
    avcodec_get_supported_config(d->encCtx, encoder, AV_CODEC_CONFIG_CHANNEL_LAYOUT, 0, &chl_configs, &chl_num);
#endif

    // Sample format selection
    if (fmt_configs && fmt_num > 0) {
        const AVSampleFormat *fmts = (const AVSampleFormat*)fmt_configs;
        for (int i = 0; i < fmt_num; ++i) if (fmts[i] == AV_SAMPLE_FMT_S16) { chosen_fmt = AV_SAMPLE_FMT_S16; break; }
        if (chosen_fmt == AV_SAMPLE_FMT_NONE && codec_id == AV_CODEC_ID_MP3) {
            for (int i = 0; i < fmt_num; ++i) if (fmts[i] == AV_SAMPLE_FMT_S16P) { chosen_fmt = AV_SAMPLE_FMT_S16P; break; }
        }
        if (chosen_fmt == AV_SAMPLE_FMT_NONE) chosen_fmt = fmts[0];
    } else {
        chosen_fmt = (codec_id == AV_CODEC_ID_MP3) ? AV_SAMPLE_FMT_S16P : AV_SAMPLE_FMT_S16;
    }
    d->encCtx->sample_fmt = chosen_fmt;

    // Rate probing
    if (sr_configs && sr_num > 0) {
        const int *srs = (const int*)sr_configs;
        int pick_sr = 0;
        for (int i = 0; i < sr_num; ++i) {
            if (srs[i] == d->encCtx->sample_rate) { pick_sr = srs[i]; break; }
        }
        if (pick_sr == 0) pick_sr = srs[0];
        d->encCtx->sample_rate = pick_sr;
    }
    if (codec_id == AV_CODEC_ID_MP3) {
        int want = (config.outputSampleRateHz == 32000 || config.outputSampleRateHz == 44100 || config.outputSampleRateHz == 48000) ? config.outputSampleRateHz : 44100;
        d->encCtx->sample_rate = want;
    }
    if (codec_id == AV_CODEC_ID_OPUS) {
        int want = (config.outputSampleRateHz == 8000 || config.outputSampleRateHz == 12000 || config.outputSampleRateHz == 16000 || config.outputSampleRateHz == 24000 || config.outputSampleRateHz == 48000) ? config.outputSampleRateHz : 48000;
        d->encCtx->sample_rate = want;
    }
    if (codec_id != AV_CODEC_ID_MP3 && codec_id != AV_CODEC_ID_OPUS) {
        if (config.outputSampleRateHz > 0) d->encCtx->sample_rate = config.outputSampleRateHz;
    }
    d->outputSampleRate = d->encCtx->sample_rate;

    // Channel layout probing
    if (chl_configs && chl_num > 0) {
        const AVChannelLayout *layouts = (const AVChannelLayout*)chl_configs;
        int pick_nb = 0;
        for (int i = 0; i < chl_num; ++i) {
            if (layouts[i].nb_channels == d->encCtx->ch_layout.nb_channels) { pick_nb = layouts[i].nb_channels; break; }
        }
        if (pick_nb == 0) pick_nb = layouts[0].nb_channels > 0 ? layouts[0].nb_channels : 1;
        if (d->encCtx->ch_layout.nb_channels != pick_nb)
            av_channel_layout_default(&d->encCtx->ch_layout, pick_nb);
    }

    // Bitrate
    if (resolvedBitrateKbps > 0) {
        d->encCtx->bit_rate = resolvedBitrateKbps * 1000;
    } else if (codec_id == AV_CODEC_ID_MP3 || codec_id == AV_CODEC_ID_AAC || codec_id == AV_CODEC_ID_OPUS) {
        d->encCtx->bit_rate = 128000;
    } else {
        d->encCtx->bit_rate = 0;
    }

    if (d->outFmt->oformat->flags & AVFMT_GLOBALHEADER)
        d->encCtx->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
    if (d->encCtx->sample_rate > 0)
        d->encCtx->time_base = AVRational{1, d->encCtx->sample_rate};

    // Open encoder (with fallback retries)
    AVDictionary *enc_opts = nullptr;
    int nb_ch = d->encCtx->ch_layout.nb_channels;
    if (nb_ch <= 0) nb_ch = 1;
    char tmpbuf[64];
    if (codec_id != AV_CODEC_ID_MP3) {
        snprintf(tmpbuf, sizeof(tmpbuf), "%d", nb_ch);
        av_dict_set(&enc_opts, "channels", tmpbuf, 0);
        snprintf(tmpbuf, sizeof(tmpbuf), "%d", d->encCtx->sample_rate);
        av_dict_set(&enc_opts, "sample_rate", tmpbuf, 0);
        if (d->encCtx->bit_rate > 0) {
            snprintf(tmpbuf, sizeof(tmpbuf), "%d", (int)d->encCtx->bit_rate);
            av_dict_set(&enc_opts, "bit_rate", tmpbuf, 0);
        }
    }

    int ret = avcodec_open2(d->encCtx, encoder, &enc_opts);
    if (ret < 0) {
        if (enc_opts) { av_dict_free(&enc_opts); enc_opts = nullptr; }

        if (codec_id == AV_CODEC_ID_MP3) {
            char errbuf[256];
            av_strerror(ret, errbuf, sizeof(errbuf));
            errorOut = std::string("ENCODE_CODEC_INIT_FAILED: ") + errbuf;
            d->cleanup();
            return nullptr;
        }

        LOGW("avcodec_open2 failed, trying alternatives.");
        const AVSampleFormat *fmts = fmt_configs ? (const AVSampleFormat*)fmt_configs : nullptr;
        if (fmts && fmt_num > 0) {
            for (int i = 0; i < fmt_num && ret < 0; ++i) {
                d->encCtx->sample_fmt = fmts[i];
                AVDictionary *try_opts = nullptr;
                snprintf(tmpbuf, sizeof(tmpbuf), "%d", d->encCtx->ch_layout.nb_channels > 0 ? d->encCtx->ch_layout.nb_channels : 1);
                av_dict_set(&try_opts, "channels", tmpbuf, 0);
                snprintf(tmpbuf, sizeof(tmpbuf), "%d", d->encCtx->sample_rate);
                av_dict_set(&try_opts, "sample_rate", tmpbuf, 0);
                if (d->encCtx->bit_rate > 0) {
                    snprintf(tmpbuf, sizeof(tmpbuf), "%d", (int)d->encCtx->bit_rate);
                    av_dict_set(&try_opts, "bit_rate", tmpbuf, 0);
                }
                int r = avcodec_open2(d->encCtx, encoder, &try_opts);
                if (r >= 0) { if (try_opts) av_dict_free(&try_opts); ret = r; break; }
                if (try_opts) av_dict_free(&try_opts);
            }
        }
        if (ret < 0) {
            AVSampleFormat fallbacks[] = {AV_SAMPLE_FMT_S16, AV_SAMPLE_FMT_S16P, AV_SAMPLE_FMT_FLTP};
            for (int fi = 0; fi < 3 && ret < 0; ++fi) {
                d->encCtx->sample_fmt = fallbacks[fi];
                AVDictionary *try_opts = nullptr;
                snprintf(tmpbuf, sizeof(tmpbuf), "%d", d->encCtx->ch_layout.nb_channels > 0 ? d->encCtx->ch_layout.nb_channels : 1);
                av_dict_set(&try_opts, "channels", tmpbuf, 0);
                snprintf(tmpbuf, sizeof(tmpbuf), "%d", d->encCtx->sample_rate);
                av_dict_set(&try_opts, "sample_rate", tmpbuf, 0);
                if (d->encCtx->bit_rate > 0) {
                    snprintf(tmpbuf, sizeof(tmpbuf), "%d", (int)d->encCtx->bit_rate);
                    av_dict_set(&try_opts, "bit_rate", tmpbuf, 0);
                }
                int r = avcodec_open2(d->encCtx, encoder, &try_opts);
                if (r >= 0) { if (try_opts) av_dict_free(&try_opts); ret = r; break; }
                if (try_opts) av_dict_free(&try_opts);
            }
        }
        if (ret < 0) {
            char eb[256];
            av_strerror(ret, eb, sizeof(eb));
            errorOut = std::string("ENCODE_CODEC_INIT_FAILED: ") + eb;
            d->cleanup();
            return nullptr;
        }
    }
    if (enc_opts) av_dict_free(&enc_opts);

    if (avcodec_parameters_from_context(d->outStream->codecpar, d->encCtx) < 0) {
        errorOut = "ENCODE_FORMAT_INIT_FAILED: Failed to set output stream parameters";
        d->cleanup();
        return nullptr;
    }

    // Open output file + write header
    if (!(d->outFmt->oformat->flags & AVFMT_NOFILE)) {
        if (avio_open(&d->outFmt->pb, config.outputPath, AVIO_FLAG_WRITE) < 0) {
            errorOut = "ENCODE_FILE_OPEN_FAILED: Failed to open output file for writing";
            d->cleanup();
            return nullptr;
        }
    }
    if (avformat_write_header(d->outFmt, nullptr) < 0) {
        errorOut = "ENCODE_FORMAT_INIT_FAILED: Failed to write output header";
        d->cleanup();
        return nullptr;
    }

    // Resampler: float32 interleaved @ inputSampleRate → encoder format
    AVChannelLayout in_ch_layout{};
    av_channel_layout_default(&in_ch_layout, config.inputChannelCount);

    if (swr_alloc_set_opts2(&d->swr,
            &d->encCtx->ch_layout, d->encCtx->sample_fmt, d->encCtx->sample_rate,
            &in_ch_layout, AV_SAMPLE_FMT_FLT, config.inputSampleRate,
            0, nullptr) < 0 || !d->swr) {
        av_channel_layout_uninit(&in_ch_layout);
        errorOut = "ENCODE_RESAMPLE_INIT_FAILED: Failed to initialize resampler";
        d->cleanup();
        return nullptr;
    }
    if (swr_init(d->swr) < 0) {
        av_channel_layout_uninit(&in_ch_layout);
        errorOut = "ENCODE_RESAMPLE_INIT_FAILED: swr_init failed";
        d->cleanup();
        return nullptr;
    }
    av_channel_layout_uninit(&in_ch_layout);

    // Encoder frame size
    d->encFrameSize =
        (codec_id == AV_CODEC_ID_MP3) ? 1152 :
        (d->encCtx->frame_size > 0 ? d->encCtx->frame_size : 1024);
    d->outChannels = d->encCtx->ch_layout.nb_channels;
    if (d->outChannels <= 0) d->outChannels = 1;
    d->bytesPerFrame = av_get_bytes_per_sample(d->encCtx->sample_fmt) * d->outChannels;

    LOGI("AudioEncodeSession: FFmpeg path, codec=%s, outRate=%d, encFrameSize=%d, bitrate=%lld",
         encoder->name, d->encCtx->sample_rate, d->encFrameSize, (long long)d->encCtx->bit_rate);
    return session;

#else
    errorOut = "ENCODE_FFMPEG_UNAVAILABLE: FFmpeg not available in this build";
    return nullptr;
#endif
}

// ---------------------------------------------------------------------------
// feedChunk()
// ---------------------------------------------------------------------------
std::string AudioEncodeSession::feedChunk(const float* samples, int frameCount) {
    if (!impl_) return "ENCODE_INVALID_SESSION: Session not initialized";
    if (impl_->finished) return "ENCODE_ALREADY_FINISHED: Session already finished";
    if (!samples || frameCount <= 0) return "";

    auto* d = impl_.get();

    if (d->cancelFlag_.load(std::memory_order_relaxed)) {
        return "ENCODE_CANCELLED: Operation cancelled";
    }

    // ----- WAV fast-path -----
    if (d->isWavFastPath) {
#ifdef HAVE_FFMPEG
        if (d->wavNeedsResample && d->wavSwr) {
            // Resample float32@inputRate → S16LE@outputRate
            int64_t outSamples = av_rescale_rnd(
                swr_get_delay(d->wavSwr, d->inputSampleRate) + frameCount,
                d->outputSampleRate, d->inputSampleRate, AV_ROUND_UP);
            d->wavConvertBuf.resize((size_t)(outSamples * d->inputChannelCount));

            const uint8_t* inPlane = reinterpret_cast<const uint8_t*>(samples);
            uint8_t* outPlane = reinterpret_cast<uint8_t*>(d->wavConvertBuf.data());
            int converted = swr_convert(d->wavSwr, &outPlane, (int)outSamples,
                &inPlane, frameCount);
            if (converted > 0) {
                size_t bytes = (size_t)converted * d->inputChannelCount * sizeof(int16_t);
                if (fwrite(d->wavConvertBuf.data(), 1, bytes, d->wavFile) != bytes) {
                    return "ENCODE_FILE_WRITE_FAILED: WAV write error";
                }
                d->wavDataBytesWritten += (int64_t)bytes;
            }
        } else
#endif
        {
            // No resample: float32 → S16LE inline
            int totalSamples = frameCount * d->inputChannelCount;
            d->wavConvertBuf.resize((size_t)totalSamples);
            for (int i = 0; i < totalSamples; ++i) {
                d->wavConvertBuf[i] = floatToS16(samples[i]);
            }
            size_t bytes = (size_t)totalSamples * sizeof(int16_t);
            if (fwrite(d->wavConvertBuf.data(), 1, bytes, d->wavFile) != bytes) {
                return "ENCODE_FILE_WRITE_FAILED: WAV write error";
            }
            d->wavDataBytesWritten += (int64_t)bytes;
        }

        d->totalFramesFed += frameCount;
        d->emitProgress();
        return "";
    }

    // ----- FFmpeg path -----
#ifdef HAVE_FFMPEG
    const int CHUNK_FRAMES = 4096;
    int offset = 0;
    while (offset < frameCount) {
        if (d->cancelFlag_.load(std::memory_order_relaxed)) {
            return "ENCODE_CANCELLED: Operation cancelled";
        }

        int chunk = std::min(CHUNK_FRAMES, frameCount - offset);
        const float* ptr = samples + offset * d->inputChannelCount;

        int64_t out_nb = av_rescale_rnd(
            swr_get_delay(d->swr, d->inputSampleRate) + chunk,
            d->encCtx->sample_rate, d->inputSampleRate, AV_ROUND_UP);

        uint8_t** outData = nullptr;
        if (av_samples_alloc_array_and_samples(&outData, nullptr, d->outChannels,
                (int)out_nb, d->encCtx->sample_fmt, 0) < 0) {
            offset += chunk;
            continue;
        }

        const uint8_t* inPlane = reinterpret_cast<const uint8_t*>(ptr);
        int converted = swr_convert(d->swr, outData, (int)out_nb, &inPlane, chunk);

        if (converted > 0) {
            int newBytes = converted * d->bytesPerFrame;
            d->maybeCompact();
            size_t oldSize = d->accumBuf.size();
            d->accumBuf.resize(oldSize + (size_t)newBytes);
            memcpy(d->accumBuf.data() + oldSize, outData[0], (size_t)newBytes);
            d->accumSamples += converted;
            d->flushAccumFrames(false);
        }

        av_freep(&outData[0]);
        av_freep(&outData);
        offset += chunk;
    }

    d->totalFramesFed += frameCount;
    d->emitProgress();
    return "";
#else
    return "ENCODE_FFMPEG_UNAVAILABLE: FFmpeg not available";
#endif
}

// ---------------------------------------------------------------------------
// finish()
// ---------------------------------------------------------------------------
std::string AudioEncodeSession::finish() {
    if (!impl_) return "ENCODE_INVALID_SESSION: Session not initialized";
    if (impl_->finished) return "";
    impl_->finished = true;

    auto* d = impl_.get();

    // ----- WAV fast-path -----
    if (d->isWavFastPath) {
#ifdef HAVE_FFMPEG
        // Drain resampler tail
        if (d->wavNeedsResample && d->wavSwr) {
            int tailCap = (int)(swr_get_delay(d->wavSwr, d->outputSampleRate) + 256);
            if (tailCap > 0) {
                d->wavConvertBuf.resize((size_t)(tailCap * d->inputChannelCount));
                uint8_t* outPlane = reinterpret_cast<uint8_t*>(d->wavConvertBuf.data());
                int tailConverted = swr_convert(d->wavSwr, &outPlane, tailCap, nullptr, 0);
                if (tailConverted > 0) {
                    size_t bytes = (size_t)tailConverted * d->inputChannelCount * sizeof(int16_t);
                    fwrite(d->wavConvertBuf.data(), 1, bytes, d->wavFile);
                    d->wavDataBytesWritten += (int64_t)bytes;
                }
            }
            swr_free(&d->wavSwr);
            d->wavSwr = nullptr;
        }
#endif
        // Seek back and finalize RIFF header
        if (d->wavFile) {
            uint8_t buf[4];
            uint32_t dataSize = (uint32_t)std::min<int64_t>(d->wavDataBytesWritten, 0xFFFFFFFE);
            uint32_t riffSize = dataSize + 36;

            fseek(d->wavFile, 4, SEEK_SET);
            writeU32LE(buf, riffSize);
            fwrite(buf, 1, 4, d->wavFile);

            fseek(d->wavFile, 40, SEEK_SET);
            writeU32LE(buf, dataSize);
            fwrite(buf, 1, 4, d->wavFile);

            fclose(d->wavFile);
            d->wavFile = nullptr;
        }

        // Final progress (100%)
        if (d->onProgress_) {
            d->onProgress_(d->totalFramesFed, d->totalFramesEstimate_, 100);
        }
        return "";
    }

    // ----- FFmpeg path -----
#ifdef HAVE_FFMPEG
    // Drain resampler tail
    {
        int tailCap = (int)(swr_get_delay(d->swr, d->encCtx->sample_rate) + 256);
        if (tailCap > 0) {
            uint8_t** tailData = nullptr;
            if (av_samples_alloc_array_and_samples(&tailData, nullptr, d->outChannels,
                    tailCap, d->encCtx->sample_fmt, 0) >= 0) {
                int tailConverted = swr_convert(d->swr, tailData, tailCap, nullptr, 0);
                if (tailConverted > 0) {
                    int tailBytes = tailConverted * d->bytesPerFrame;
                    d->maybeCompact();
                    size_t oldSize = d->accumBuf.size();
                    d->accumBuf.resize(oldSize + (size_t)tailBytes);
                    memcpy(d->accumBuf.data() + oldSize, tailData[0], (size_t)tailBytes);
                    d->accumSamples += tailConverted;
                }
                av_freep(&tailData[0]);
                av_freep(&tailData);
            }
        }
    }

    // Send remaining partial frames
    d->flushAccumFrames(true);

    // Flush encoder
    avcodec_send_frame(d->encCtx, nullptr);
    {
        AVPacket* flushPkt = av_packet_alloc();
        while (avcodec_receive_packet(d->encCtx, flushPkt) == 0) {
            flushPkt->stream_index = d->outStream->index;
            av_packet_rescale_ts(flushPkt, d->encCtx->time_base, d->outStream->time_base);
            av_interleaved_write_frame(d->outFmt, flushPkt);
            av_packet_unref(flushPkt);
        }
        av_packet_free(&flushPkt);
    }

    // Write trailer
    av_write_trailer(d->outFmt);

    // Final progress
    if (d->onProgress_) {
        d->onProgress_(d->totalFramesFed, d->totalFramesEstimate_, 100);
    }

    // Cleanup FFmpeg resources (but keep impl_ alive for framesEncoded())
    swr_free(&d->swr);
    d->swr = nullptr;
    avcodec_free_context(&d->encCtx);
    d->encCtx = nullptr;
    if (d->outFmt) {
        if (!(d->outFmt->oformat->flags & AVFMT_NOFILE) && d->outFmt->pb)
            avio_closep(&d->outFmt->pb);
        avformat_free_context(d->outFmt);
        d->outFmt = nullptr;
    }

    return "";
#else
    return "ENCODE_FFMPEG_UNAVAILABLE: FFmpeg not available";
#endif
}

} // namespace sherpa
