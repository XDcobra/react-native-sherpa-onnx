/**
 * audio_pcm_to_format.cpp — Encode raw float32 PCM samples to an output file
 * using FFmpeg. Bypasses demuxer/decoder entirely; samples go directly through
 * SwrContext → encoder → output muxer.
 */
#include <string>
#include <vector>
#include <algorithm>
#include <cstring>
#include <cstdio>
#include <sys/stat.h>

#define LOG_TAG "AudioPcmToFmt"
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

#include "audio_convert_file.h"

std::string sherpa_audio_convert_pcm_to_format(
    const float *samples,
    int numSamples,
    int sampleRate,
    int channelCount,
    const char *outputPath,
    const char *formatHint,
    int outputSampleRateHz)
{
#ifdef HAVE_FFMPEG
    if (!samples || numSamples <= 0) return std::string("No samples provided");
    if (sampleRate <= 0) return std::string("Invalid sample rate");
    if (channelCount <= 0) return std::string("Invalid channel count");
    if (!outputPath || !outputPath[0]) return std::string("No output path");

    std::string fmt(formatHint ? formatHint : "");
    bool isWav = (fmt == "wav" || fmt.empty());

    // ---- Codec selection ----
    AVCodecID codec_id = AV_CODEC_ID_NONE;
    if (isWav) codec_id = AV_CODEC_ID_PCM_S16LE;
    else if (fmt == "mp3") codec_id = AV_CODEC_ID_MP3;
    else if (fmt == "flac") codec_id = AV_CODEC_ID_FLAC;
    else if (fmt == "m4a" || fmt == "aac") codec_id = AV_CODEC_ID_AAC;
    else if (fmt == "opus" || fmt == "ogg" || fmt == "webm" || fmt == "mkv") codec_id = AV_CODEC_ID_OPUS;
    else codec_id = AV_CODEC_ID_PCM_S16LE;

    int totalFrames = numSamples / channelCount;
    LOGI("pcmToFormat: numSamples=%d sr=%d ch=%d fmt=%s outputPath=%s outRate=%d",
         numSamples, sampleRate, channelCount, formatHint ? formatHint : "", outputPath, outputSampleRateHz);

    // ---- Output context ----
    AVFormatContext* outFmt = nullptr;
    if (avformat_alloc_output_context2(&outFmt, nullptr, nullptr, outputPath) < 0 || !outFmt) {
        return std::string("Failed to allocate output context");
    }

    // ---- Encoder selection ----
    const AVCodec* encoder = nullptr;
    if (codec_id == AV_CODEC_ID_MP3) {
        encoder = avcodec_find_encoder_by_name("libshine");
        if (!encoder) { avformat_free_context(outFmt); return std::string("libshine encoder not available in this build"); }
    } else if (codec_id == AV_CODEC_ID_OPUS) {
        encoder = avcodec_find_encoder_by_name("libopus");
        if (!encoder) { avformat_free_context(outFmt); return std::string("libopus encoder not available in this build"); }
    } else {
        encoder = avcodec_find_encoder(codec_id);
        if (!encoder) { avformat_free_context(outFmt); return std::string("Requested encoder not available in this build"); }
    }

    AVStream* outStream = avformat_new_stream(outFmt, nullptr);
    if (!outStream) { avformat_free_context(outFmt); return std::string("Failed to create output stream"); }

    AVCodecContext* encCtx = avcodec_alloc_context3(encoder);
    if (!encCtx) { avformat_free_context(outFmt); return std::string("Failed to allocate encoder context"); }

    // ---- Channel layout ----
    av_channel_layout_default(&encCtx->ch_layout, channelCount);

    if (codec_id == AV_CODEC_ID_MP3) {
        int want_ch = (channelCount == 2) ? 2 : 1;
        av_channel_layout_uninit(&encCtx->ch_layout);
        if (want_ch == 2) {
            AVChannelLayout stereo = AV_CHANNEL_LAYOUT_STEREO;
            if (av_channel_layout_copy(&encCtx->ch_layout, &stereo) < 0)
                av_channel_layout_default(&encCtx->ch_layout, 2);
        } else {
            AVChannelLayout mono = AV_CHANNEL_LAYOUT_MONO;
            if (av_channel_layout_copy(&encCtx->ch_layout, &mono) < 0)
                av_channel_layout_default(&encCtx->ch_layout, 1);
        }
    }

    // ---- Sample rate ----
    // Default: use buffer's native rate; format-specific overrides below.
    encCtx->sample_rate = sampleRate;

    if (isWav) {
        encCtx->sample_fmt = AV_SAMPLE_FMT_S16;
        if (outputSampleRateHz > 0) encCtx->sample_rate = outputSampleRateHz;
        // else keep sampleRate (buffer's native rate)
    }

    // ---- Probe encoder capabilities ----
    AVSampleFormat chosen_fmt = AV_SAMPLE_FMT_NONE;
    const void *fmt_configs = nullptr;
    int fmt_num = 0;
    const void *sr_configs = nullptr;
    int sr_num = 0;
    const void *chl_configs = nullptr;
    int chl_num = 0;
#if defined(AV_CODEC_CONFIG_SAMPLE_FORMAT)
    avcodec_get_supported_config(encCtx, encoder, AV_CODEC_CONFIG_SAMPLE_FORMAT, 0, &fmt_configs, &fmt_num);
    avcodec_get_supported_config(encCtx, encoder, AV_CODEC_CONFIG_SAMPLE_RATE, 0, &sr_configs, &sr_num);
    avcodec_get_supported_config(encCtx, encoder, AV_CODEC_CONFIG_CHANNEL_LAYOUT, 0, &chl_configs, &chl_num);
#endif

    if (!isWav) {
        if (fmt_configs && fmt_num > 0) {
            const AVSampleFormat *fmts = (const AVSampleFormat *)fmt_configs;
            for (int i = 0; i < fmt_num; ++i) if (fmts[i] == AV_SAMPLE_FMT_S16) { chosen_fmt = AV_SAMPLE_FMT_S16; break; }
            if (chosen_fmt == AV_SAMPLE_FMT_NONE && codec_id == AV_CODEC_ID_MP3) {
                for (int i = 0; i < fmt_num; ++i) if (fmts[i] == AV_SAMPLE_FMT_S16P) { chosen_fmt = AV_SAMPLE_FMT_S16P; break; }
            }
            if (chosen_fmt == AV_SAMPLE_FMT_NONE) chosen_fmt = fmts[0];
        } else {
            chosen_fmt = (codec_id == AV_CODEC_ID_MP3) ? AV_SAMPLE_FMT_S16P : AV_SAMPLE_FMT_S16;
        }
        encCtx->sample_fmt = chosen_fmt;
    }

    // Rate probing
    if (sr_configs && sr_num > 0) {
        const int *srs = (const int*)sr_configs;
        int pick_sr = 0;
        for (int i = 0; i < sr_num; ++i) {
            if (srs[i] == encCtx->sample_rate) { pick_sr = srs[i]; break; }
        }
        if (pick_sr == 0) pick_sr = srs[0];
        encCtx->sample_rate = pick_sr;
    }
    if (codec_id == AV_CODEC_ID_MP3) {
        int want = (outputSampleRateHz == 32000 || outputSampleRateHz == 44100 || outputSampleRateHz == 48000) ? outputSampleRateHz : 44100;
        encCtx->sample_rate = want;
    }
    if (codec_id == AV_CODEC_ID_OPUS) {
        int want = (outputSampleRateHz == 8000 || outputSampleRateHz == 12000 || outputSampleRateHz == 16000 || outputSampleRateHz == 24000 || outputSampleRateHz == 48000) ? outputSampleRateHz : 48000;
        encCtx->sample_rate = want;
    }
    if (!isWav && codec_id != AV_CODEC_ID_MP3 && codec_id != AV_CODEC_ID_OPUS) {
        if (outputSampleRateHz > 0) encCtx->sample_rate = outputSampleRateHz;
    }

    // Channel layout probing
    if (chl_configs && chl_num > 0) {
        const AVChannelLayout *layouts = (const AVChannelLayout *)chl_configs;
        int pick_nb = 0;
        for (int i = 0; i < chl_num; ++i) {
            if (layouts[i].nb_channels == encCtx->ch_layout.nb_channels) { pick_nb = layouts[i].nb_channels; break; }
        }
        if (pick_nb == 0) pick_nb = layouts[0].nb_channels > 0 ? layouts[0].nb_channels : 1;
        if (encCtx->ch_layout.nb_channels != pick_nb) av_channel_layout_default(&encCtx->ch_layout, pick_nb);
    }

    // Bitrate
    if (codec_id == AV_CODEC_ID_MP3 || codec_id == AV_CODEC_ID_AAC || codec_id == AV_CODEC_ID_OPUS) encCtx->bit_rate = 128000;
    else encCtx->bit_rate = 0;

    if (outFmt->oformat->flags & AVFMT_GLOBALHEADER) encCtx->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
    if (encCtx->sample_rate > 0) encCtx->time_base = AVRational{1, encCtx->sample_rate};

    // ---- Open encoder (with fallback retries) ----
    AVDictionary *enc_opts = nullptr;
    int nb_ch = encCtx->ch_layout.nb_channels;
    if (nb_ch <= 0) nb_ch = 1;
    char tmpbuf[64];
    if (codec_id != AV_CODEC_ID_MP3) {
        snprintf(tmpbuf, sizeof(tmpbuf), "%d", nb_ch);
        av_dict_set(&enc_opts, "channels", tmpbuf, 0);
        snprintf(tmpbuf, sizeof(tmpbuf), "%d", encCtx->sample_rate);
        av_dict_set(&enc_opts, "sample_rate", tmpbuf, 0);
        if (encCtx->bit_rate > 0) {
            snprintf(tmpbuf, sizeof(tmpbuf), "%d", (int)encCtx->bit_rate);
            av_dict_set(&enc_opts, "bit_rate", tmpbuf, 0);
        }
    }

    int ret = avcodec_open2(encCtx, encoder, &enc_opts);
    if (ret < 0) {
        if (enc_opts) { av_dict_free(&enc_opts); enc_opts = nullptr; }

        if (codec_id == AV_CODEC_ID_MP3) {
            char errbuf[256]; av_strerror(ret, errbuf, sizeof(errbuf));
            std::string msg = std::string("Failed to open encoder: ") + errbuf;
            avcodec_free_context(&encCtx); avformat_free_context(outFmt);
            return msg;
        }

        LOGW("avcodec_open2 failed, trying alternatives.");
        const AVSampleFormat *fmts = fmt_configs ? (const AVSampleFormat*)fmt_configs : nullptr;
        if (fmts && fmt_num > 0) {
            for (int i = 0; i < fmt_num && ret < 0; ++i) {
                encCtx->sample_fmt = fmts[i];
                AVDictionary *try_opts = nullptr;
                snprintf(tmpbuf, sizeof(tmpbuf), "%d", encCtx->ch_layout.nb_channels > 0 ? encCtx->ch_layout.nb_channels : 1);
                av_dict_set(&try_opts, "channels", tmpbuf, 0);
                snprintf(tmpbuf, sizeof(tmpbuf), "%d", encCtx->sample_rate);
                av_dict_set(&try_opts, "sample_rate", tmpbuf, 0);
                if (encCtx->bit_rate > 0) { snprintf(tmpbuf, sizeof(tmpbuf), "%d", (int)encCtx->bit_rate); av_dict_set(&try_opts, "bit_rate", tmpbuf, 0); }
                int r = avcodec_open2(encCtx, encoder, &try_opts);
                if (r >= 0) { if (try_opts) av_dict_free(&try_opts); ret = r; break; }
                if (try_opts) av_dict_free(&try_opts);
            }
        }
        if (ret < 0) {
            AVSampleFormat fallbacks[] = { AV_SAMPLE_FMT_S16, AV_SAMPLE_FMT_S16P, AV_SAMPLE_FMT_FLTP };
            for (int fi = 0; fi < 3 && ret < 0; ++fi) {
                encCtx->sample_fmt = fallbacks[fi];
                AVDictionary *try_opts = nullptr;
                snprintf(tmpbuf, sizeof(tmpbuf), "%d", encCtx->ch_layout.nb_channels > 0 ? encCtx->ch_layout.nb_channels : 1);
                av_dict_set(&try_opts, "channels", tmpbuf, 0);
                snprintf(tmpbuf, sizeof(tmpbuf), "%d", encCtx->sample_rate);
                av_dict_set(&try_opts, "sample_rate", tmpbuf, 0);
                if (encCtx->bit_rate > 0) { snprintf(tmpbuf, sizeof(tmpbuf), "%d", (int)encCtx->bit_rate); av_dict_set(&try_opts, "bit_rate", tmpbuf, 0); }
                int r = avcodec_open2(encCtx, encoder, &try_opts);
                if (r >= 0) { if (try_opts) av_dict_free(&try_opts); ret = r; break; }
                if (try_opts) av_dict_free(&try_opts);
            }
        }
        if (ret < 0) {
            char eb[256]; av_strerror(ret, eb, sizeof(eb));
            std::string msg = std::string("Failed to open encoder: ") + eb;
            avcodec_free_context(&encCtx); avformat_free_context(outFmt);
            return msg;
        }
    }
    if (enc_opts) av_dict_free(&enc_opts);

    if (avcodec_parameters_from_context(outStream->codecpar, encCtx) < 0) {
        avcodec_free_context(&encCtx); avformat_free_context(outFmt);
        return std::string("Failed to set output stream parameters");
    }

    // ---- Open output file + write header ----
    if (!(outFmt->oformat->flags & AVFMT_NOFILE)) {
        if (avio_open(&outFmt->pb, outputPath, AVIO_FLAG_WRITE) < 0) {
            avcodec_free_context(&encCtx); avformat_free_context(outFmt);
            return std::string("Failed to open output file for writing");
        }
    }
    if (avformat_write_header(outFmt, nullptr) < 0) {
        if (!(outFmt->oformat->flags & AVFMT_NOFILE)) avio_closep(&outFmt->pb);
        avcodec_free_context(&encCtx); avformat_free_context(outFmt);
        return std::string("Failed to write output header");
    }

    // ---- Resampler: float32 interleaved @ sampleRate → encoder format ----
    SwrContext* swr = nullptr;
    AVChannelLayout in_ch_layout{};
    av_channel_layout_default(&in_ch_layout, channelCount);

    if (swr_alloc_set_opts2(&swr,
            &encCtx->ch_layout, encCtx->sample_fmt, encCtx->sample_rate,
            &in_ch_layout, AV_SAMPLE_FMT_FLT, sampleRate,
            0, nullptr) < 0 || !swr) {
        av_channel_layout_uninit(&in_ch_layout);
        avcodec_free_context(&encCtx);
        if (!(outFmt->oformat->flags & AVFMT_NOFILE)) avio_closep(&outFmt->pb);
        avformat_free_context(outFmt);
        return std::string("Failed to initialize resampler");
    }
    if (swr_init(swr) < 0) {
        av_channel_layout_uninit(&in_ch_layout);
        swr_free(&swr);
        avcodec_free_context(&encCtx);
        if (!(outFmt->oformat->flags & AVFMT_NOFILE)) avio_closep(&outFmt->pb);
        avformat_free_context(outFmt);
        return std::string("Failed to initialize resampler (swr_init)");
    }
    av_channel_layout_uninit(&in_ch_layout);

    // ---- Encoding variables ----
    int64_t encoder_pts = 0;
    const int enc_frame_size =
        (codec_id == AV_CODEC_ID_MP3) ? 1152 :
        (encCtx->frame_size > 0 ? encCtx->frame_size : 1024);
    int out_ch = encCtx->ch_layout.nb_channels;
    if (out_ch <= 0) out_ch = 1;
    int bytes_per_sample = av_get_bytes_per_sample(encCtx->sample_fmt);
    const int bytesPerFrame = bytes_per_sample * out_ch;

    // Accumulation buffer with read offset (avoids O(n²) memmove).
    std::vector<uint8_t> accumBuf;
    size_t accumReadOffset = 0;
    int accumSamples = 0;
    const size_t kCompactThreshold = 256 * 1024;

    auto maybeCompact = [&]() {
        if (accumReadOffset == 0) return;
        if (accumReadOffset < kCompactThreshold && accumReadOffset * 2 < accumBuf.size()) return;
        size_t valid = accumBuf.size() - accumReadOffset;
        if (valid > 0) memmove(accumBuf.data(), accumBuf.data() + accumReadOffset, valid);
        accumBuf.resize(valid);
        accumReadOffset = 0;
    };

    int totalPacketsFromEncoder = 0;

    // Helper: send exactly enc_frame_size samples from accumBuf to encoder
    auto flushAccumFrames = [&](bool sendPartial) {
        int needed = enc_frame_size;
        if (needed <= 0) return;
        while (accumSamples >= needed || (sendPartial && accumSamples > 0)) {
            int toSend = (accumSamples >= needed) ? needed : accumSamples;
            AVFrame* ef = av_frame_alloc();
            if (!ef) break;
            ef->format = encCtx->sample_fmt;
            ef->sample_rate = encCtx->sample_rate;
            if (av_channel_layout_copy(&ef->ch_layout, &encCtx->ch_layout) < 0) { av_frame_free(&ef); break; }
            ef->nb_samples = toSend;
            if (av_frame_get_buffer(ef, 0) < 0) { av_channel_layout_uninit(&ef->ch_layout); av_frame_free(&ef); break; }
            int copyBytes = toSend * bytesPerFrame;
            memcpy(ef->data[0], accumBuf.data() + accumReadOffset, copyBytes);
            ef->pts = encoder_pts;
            encoder_pts += toSend;
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
                        totalPacketsFromEncoder++;
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
                totalPacketsFromEncoder++;
            }
            av_packet_free(&op);
            av_channel_layout_uninit(&ef->ch_layout);
            av_frame_free(&ef);
            if (!sendPartial && accumSamples < needed) break;
        }
    };

    // ---- Main loop: process input PCM in chunks ----
    const int CHUNK_FRAMES = 4096; // samples per channel per iteration
    int frameOffset = 0;

    while (frameOffset < totalFrames) {
        int chunkFrames = std::min(CHUNK_FRAMES, totalFrames - frameOffset);
        const float* chunkPtr = samples + frameOffset * channelCount;

        int64_t out_nb_samples = av_rescale_rnd(
            swr_get_delay(swr, sampleRate) + chunkFrames,
            encCtx->sample_rate, sampleRate, AV_ROUND_UP);

        uint8_t** outData = nullptr;
        if (av_samples_alloc_array_and_samples(&outData, nullptr, out_ch,
                (int)out_nb_samples, encCtx->sample_fmt, 0) < 0) {
            frameOffset += chunkFrames;
            continue;
        }

        const uint8_t* inPlane = reinterpret_cast<const uint8_t*>(chunkPtr);
        int converted = swr_convert(swr, outData, (int)out_nb_samples,
            &inPlane, chunkFrames);

        if (converted > 0) {
            int newBytes = converted * bytesPerFrame;
            maybeCompact();
            size_t oldSize = accumBuf.size();
            accumBuf.resize(oldSize + (size_t)newBytes);
            memcpy(accumBuf.data() + oldSize, outData[0], (size_t)newBytes);
            accumSamples += converted;
            flushAccumFrames(false);
        }

        av_freep(&outData[0]);
        av_freep(&outData);
        frameOffset += chunkFrames;
    }

    // ---- Drain resampler tail ----
    {
        int tailCap = swr_get_delay(swr, encCtx->sample_rate) + 256;
        if (tailCap > 0) {
            uint8_t** tailData = nullptr;
            if (av_samples_alloc_array_and_samples(&tailData, nullptr, out_ch, tailCap, encCtx->sample_fmt, 0) >= 0) {
                int tailConverted = swr_convert(swr, tailData, tailCap, nullptr, 0);
                if (tailConverted > 0) {
                    int tailBytes = tailConverted * bytesPerFrame;
                    maybeCompact();
                    size_t oldSize = accumBuf.size();
                    accumBuf.resize(oldSize + (size_t)tailBytes);
                    memcpy(accumBuf.data() + oldSize, tailData[0], (size_t)tailBytes);
                    accumSamples += tailConverted;
                }
                av_freep(&tailData[0]);
                av_freep(&tailData);
            }
        }
    }

    // Send remaining partial frames
    flushAccumFrames(true);

    // ---- Flush encoder ----
    avcodec_send_frame(encCtx, nullptr);
    {
        AVPacket* flushPkt = av_packet_alloc();
        while (avcodec_receive_packet(encCtx, flushPkt) == 0) {
            flushPkt->stream_index = outStream->index;
            av_packet_rescale_ts(flushPkt, encCtx->time_base, outStream->time_base);
            av_interleaved_write_frame(outFmt, flushPkt);
            av_packet_unref(flushPkt);
        }
        av_packet_free(&flushPkt);
    }

    // ---- Trailer + cleanup ----
    av_write_trailer(outFmt);
    if (!(outFmt->oformat->flags & AVFMT_NOFILE)) avio_closep(&outFmt->pb);

    struct stat stOut = {};
    long outputSizeBytes = (stat(outputPath, &stOut) == 0 && S_ISREG(stOut.st_mode)) ? (long)stOut.st_size : -1;
    LOGI("pcmToFormat: done outputPath=%s outputSizeBytes=%ld packets=%d",
         outputPath, outputSizeBytes, totalPacketsFromEncoder);

    swr_free(&swr);
    avcodec_free_context(&encCtx);
    avformat_free_context(outFmt);

    return std::string("");
#else
    (void)samples; (void)numSamples; (void)sampleRate; (void)channelCount;
    (void)outputPath; (void)formatHint; (void)outputSampleRateHz;
    return std::string("FFmpeg not available. Build prebuilts with third_party/ffmpeg_prebuilt/build_ffmpeg.ps1 or build_ffmpeg.sh.");
#endif
}
