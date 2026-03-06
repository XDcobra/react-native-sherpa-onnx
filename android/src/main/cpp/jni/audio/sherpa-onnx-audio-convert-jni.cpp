/**
 * sherpa-onnx-audio-convert-jni.cpp
 *
 * Purpose: JNI for converting arbitrary audio files to WAV 16 kHz mono 16-bit PCM (sherpa-onnx
 * input format). When HAVE_FFMPEG is set, FFmpeg is used; otherwise nativeConvertAudioToWav16k
 * returns an error. Used by the Kotlin audio conversion API.
 */
#include <android/log.h>
#include <jni.h>
#include <string>
#include <sys/stat.h>

#define LOG_TAG "AudioConvertJNI"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

#ifdef HAVE_FFMPEG
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/opt.h>
#include <libavutil/error.h>
#include <libswresample/swresample.h>
}
#include <cstdio>
#include <vector>
#endif

// Forward declaration — convertToFormat handles all formats including WAV (16 kHz mono).
static std::string convertToFormat(const char* inputPath, const char* outputPath, const char* formatHint, int outputSampleRateHz);

// Convenience: convert any audio to 16 kHz mono WAV via the main convertToFormat pipeline.
static std::string convertToWav16kMono(const char* inputPath, const char* outputPath) {
    return convertToFormat(inputPath, outputPath, "wav", 16000);
}

// Generic conversion: supports writing WAV/MP3/FLAC depending on output file extension and linked encoders.
// WAV output is 16 kHz mono PCM (sherpa-onnx). outputSampleRateHz is only used for MP3 (libshine: 32000/44100/48000); 0 = default 44100.
static std::string convertToFormat(const char* inputPath, const char* outputPath, const char* formatHint, int outputSampleRateHz) {
#ifdef HAVE_FFMPEG
    std::string fmt(formatHint ? formatHint : "");
    bool isWav = (fmt == "wav" || fmt == "wav16k" || fmt.empty());

    AVCodecID codec_id = AV_CODEC_ID_NONE;
    if (isWav) codec_id = AV_CODEC_ID_PCM_S16LE;
    else if (fmt == "mp3") codec_id = AV_CODEC_ID_MP3;
    else if (fmt == "flac") codec_id = AV_CODEC_ID_FLAC;
    else codec_id = AV_CODEC_ID_PCM_S16LE;

    // The implementation for generic encoding uses the same decode+resample pipeline
    // but selects encoder by codec_id and creates an output container based on file extension.
    // For brevity we reuse much of the WAV path but change encoder selection.

    struct stat stIn = {};
    long inputSizeBytes = (stat(inputPath, &stIn) == 0 && S_ISREG(stIn.st_mode)) ? (long)stIn.st_size : -1;
    LOGI("convertToFormat: inputPath=%s inputSizeBytes=%ld format=%s outputPath=%s", inputPath ? inputPath : "(null)", inputSizeBytes, formatHint ? formatHint : "", outputPath ? outputPath : "(null)");

    // Open input
    AVFormatContext* inFmt = nullptr;
    if (avformat_open_input(&inFmt, inputPath, nullptr, nullptr) < 0) {
        LOGE("Failed to open input file (generic): inputPath=%s", inputPath ? inputPath : "(null)");
        return std::string("Failed to open input file");
    }
    if (avformat_find_stream_info(inFmt, nullptr) < 0) {
        avformat_close_input(&inFmt);
        return std::string("Failed to find stream info");
    }

    int audioStreamIndex = -1;
    for (unsigned i = 0; i < inFmt->nb_streams; ++i) {
        if (inFmt->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) {
            audioStreamIndex = i;
            break;
        }
    }
    if (audioStreamIndex < 0) {
        avformat_close_input(&inFmt);
        return std::string("No audio stream found in input");
    }

    AVStream* inStream = inFmt->streams[audioStreamIndex];
    const AVCodec* decoder = avcodec_find_decoder(inStream->codecpar->codec_id);
    if (!decoder) {
        avformat_close_input(&inFmt);
        return std::string("Unsupported input codec");
    }

    AVCodecContext* decCtx = avcodec_alloc_context3(decoder);
    if (!decCtx) {
        avformat_close_input(&inFmt);
        return std::string("Failed to allocate decoder context");
    }
    if (avcodec_parameters_to_context(decCtx, inStream->codecpar) < 0) {
        avcodec_free_context(&decCtx);
        avformat_close_input(&inFmt);
        return std::string("Failed to copy codec parameters");
    }
    if (avcodec_open2(decCtx, decoder, nullptr) < 0) {
        avcodec_free_context(&decCtx);
        avformat_close_input(&inFmt);
        return std::string("Failed to open decoder");
    }

    // We'll configure resampler later based on encoder requirements.
    SwrContext* swr = nullptr;

    AVFormatContext* outFmt = nullptr;
    if (avformat_alloc_output_context2(&outFmt, nullptr, nullptr, outputPath) < 0 || !outFmt) {
        swr_free(&swr);
        avcodec_free_context(&decCtx);
        avformat_close_input(&inFmt);
        return std::string("Failed to allocate output context");
    }

    const AVCodec* encoder = nullptr;
    if (codec_id == AV_CODEC_ID_MP3) {
        // Force using libshine for MP3 encoding. Do NOT fall back to libmp3lame or
        // internal ffmpeg MP3 encoder to respect licensing choice.
        encoder = avcodec_find_encoder_by_name("libshine");
        if (!encoder) {
            avformat_free_context(outFmt);
            swr_free(&swr);
            avcodec_free_context(&decCtx);
            avformat_close_input(&inFmt);
            return std::string("libshine encoder not available in this build");
        }
    } else {
        encoder = avcodec_find_encoder(codec_id);
        if (!encoder) {
            avformat_free_context(outFmt);
            swr_free(&swr);
            avcodec_free_context(&decCtx);
            avformat_close_input(&inFmt);
            return std::string("Requested encoder not available in this build");
        }
    }

    AVStream* outStream = avformat_new_stream(outFmt, nullptr);
    if (!outStream) {
        avformat_free_context(outFmt);
        swr_free(&swr);
        avcodec_free_context(&decCtx);
        avformat_close_input(&inFmt);
        return std::string("Failed to create output stream");
    }

    AVCodecContext* encCtx = avcodec_alloc_context3(encoder);
    // Preserve input sample rate / channel layout by default
    if (!encCtx) {
        avformat_free_context(outFmt);
        swr_free(&swr);
        avcodec_free_context(&decCtx);
        avformat_close_input(&inFmt);
        return std::string("Failed to allocate encoder context");
    }
    // Set channel layout: prefer input stream layout, otherwise decoder layout.
    if (inStream->codecpar->ch_layout.nb_channels) {
        if (av_channel_layout_copy(&encCtx->ch_layout, &inStream->codecpar->ch_layout) < 0) {
            avcodec_free_context(&encCtx);
            avformat_free_context(outFmt);
            swr_free(&swr);
            avcodec_free_context(&decCtx);
            avformat_close_input(&inFmt);
            return std::string("Failed to copy input channel layout to encoder");
        }
    } else {
        if (av_channel_layout_copy(&encCtx->ch_layout, &decCtx->ch_layout) < 0) {
            avcodec_free_context(&encCtx);
            avformat_free_context(outFmt);
            swr_free(&swr);
            avcodec_free_context(&decCtx);
            avformat_close_input(&inFmt);
            return std::string("Failed to set encoder channel layout");
        }
    }

    // If using libshine (MP3), ensure channel_layout is explicitly set (old encoders expect it)
    if (codec_id == AV_CODEC_ID_MP3) {
        // If encCtx->ch_layout appears empty, set default based on input stream channels
        if (encCtx->ch_layout.nb_channels <= 0) {
            int nb_channels = 1;
            if (inStream->codecpar && inStream->codecpar->ch_layout.nb_channels > 0) {
                nb_channels = inStream->codecpar->ch_layout.nb_channels;
            } else if (decCtx && decCtx->ch_layout.nb_channels > 0) {
                nb_channels = decCtx->ch_layout.nb_channels;
            }
            av_channel_layout_default(&encCtx->ch_layout, nb_channels);
        }
    }

    // Set sample rate from input/decoder if not already set
    encCtx->sample_rate = inStream->codecpar->sample_rate ? inStream->codecpar->sample_rate : decCtx->sample_rate;

    // WAV output: force 16 kHz mono S16 (sherpa-onnx STT requirement)
    if (isWav) {
        encCtx->sample_rate = 16000;
        encCtx->sample_fmt = AV_SAMPLE_FMT_S16;
        av_channel_layout_uninit(&encCtx->ch_layout);
        AVChannelLayout mono = AV_CHANNEL_LAYOUT_MONO;
        av_channel_layout_copy(&encCtx->ch_layout, &mono);
    }

    // Probe encoder-supported configurations (sample formats, sample rates, channel layouts)
    AVSampleFormat chosen_fmt = AV_SAMPLE_FMT_NONE;
    const void *fmt_configs = nullptr;
    int fmt_num = 0;
    avcodec_get_supported_config(encCtx, encoder, AV_CODEC_CONFIG_SAMPLE_FORMAT, 0, &fmt_configs, &fmt_num);

    const void *sr_configs = nullptr;
    int sr_num = 0;
    avcodec_get_supported_config(encCtx, encoder, AV_CODEC_CONFIG_SAMPLE_RATE, 0, &sr_configs, &sr_num);

    const void *chl_configs = nullptr;
    int chl_num = 0;
    avcodec_get_supported_config(encCtx, encoder, AV_CODEC_CONFIG_CHANNEL_LAYOUT, 0, &chl_configs, &chl_num);

    if (fmt_configs && fmt_num > 0) {
        const AVSampleFormat *fmts = (const AVSampleFormat *)fmt_configs;
        // prefer interleaved S16, then planar S16P, then decoder fmt, then first
        for (int i = 0; i < fmt_num; ++i) if (fmts[i] == AV_SAMPLE_FMT_S16) { chosen_fmt = AV_SAMPLE_FMT_S16; break; }
        if (chosen_fmt == AV_SAMPLE_FMT_NONE && codec_id == AV_CODEC_ID_MP3) {
            for (int i = 0; i < fmt_num; ++i) if (fmts[i] == AV_SAMPLE_FMT_S16P) { chosen_fmt = AV_SAMPLE_FMT_S16P; break; }
        }
        if (chosen_fmt == AV_SAMPLE_FMT_NONE) {
            for (int i = 0; i < fmt_num; ++i) if (fmts[i] == decCtx->sample_fmt) { chosen_fmt = decCtx->sample_fmt; break; }
        }
        if (chosen_fmt == AV_SAMPLE_FMT_NONE && fmt_num > 0) chosen_fmt = fmts[0];
    } else {
        // libshine only supports S16P; default to S16P for MP3 so open succeeds
        chosen_fmt = (codec_id == AV_CODEC_ID_MP3) ? AV_SAMPLE_FMT_S16P : AV_SAMPLE_FMT_S16;
    }
    encCtx->sample_fmt = chosen_fmt;

    // If supported sample rates are provided, pick one matching our target or fall back
    if (sr_configs && sr_num > 0) {
        const int *srs = (const int*)sr_configs;
        int pick_sr = 0;
        for (int i = 0; i < sr_num; ++i) {
            if (srs[i] == encCtx->sample_rate) { pick_sr = srs[i]; break; }
        }
        if (pick_sr == 0) pick_sr = srs[0];
        encCtx->sample_rate = pick_sr;
    }
    // libshine only supports 32000, 44100, 48000 Hz. Use outputSampleRateHz if valid (32000/44100/48000), else default 44100.
    if (codec_id == AV_CODEC_ID_MP3) {
        int want = (outputSampleRateHz == 32000 || outputSampleRateHz == 44100 || outputSampleRateHz == 48000) ? outputSampleRateHz : 44100;
        if (encCtx->sample_rate != want) encCtx->sample_rate = want;
    }

    // If supported channel layouts given, prefer matching channels else pick first
    if (chl_configs && chl_num > 0) {
        const AVChannelLayout *layouts = (const AVChannelLayout *)chl_configs;
        int pick_nb = 0;
        for (int i = 0; i < chl_num; ++i) {
            const AVChannelLayout *l = &layouts[i];
            if (l->nb_channels == encCtx->ch_layout.nb_channels) { pick_nb = l->nb_channels; break; }
        }
        if (pick_nb == 0) pick_nb = layouts[0].nb_channels > 0 ? layouts[0].nb_channels : 1;
        if (encCtx->ch_layout.nb_channels != pick_nb) av_channel_layout_default(&encCtx->ch_layout, pick_nb);
    }

    // libshine reads only AVCodecContext (not options). Use a well-known channel layout so nb_channels is always valid.
    if (codec_id == AV_CODEC_ID_MP3) {
        int want_ch = (encCtx->ch_layout.nb_channels == 2) ? 2 : 1;
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

    // Set a sensible default bitrate for compressed codecs
    if (codec_id == AV_CODEC_ID_MP3 || codec_id == AV_CODEC_ID_AAC) encCtx->bit_rate = 128000;
    else encCtx->bit_rate = 0; // lossless or PCM may ignore

    if (outFmt->oformat->flags & AVFMT_GLOBALHEADER) encCtx->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;

    // Ensure sensible timebase and try opening encoder with options. If it fails, iterate supported sample formats and retry.
    if (encCtx->sample_rate > 0) encCtx->time_base = AVRational{1, encCtx->sample_rate};

    AVDictionary *enc_opts = nullptr;
    int nb_ch = encCtx->ch_layout.nb_channels;
    if (nb_ch <= 0) nb_ch = 1;
    char tmpbuf[64];
    // For libshine, do not pass options — it uses only AVCodecContext; options can cause "Invalid argument".
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
        char errbuf[256];
        av_strerror(ret, errbuf, sizeof(errbuf));
        if (enc_opts) { av_dict_free(&enc_opts); enc_opts = nullptr; }

        // libshine (MP3): we already set S16P, valid rate, mono/stereo; no useful fallback.
        if (codec_id == AV_CODEC_ID_MP3) {
            std::string msg = std::string("Failed to open encoder: ") + errbuf;
            avcodec_free_context(&encCtx);
            avformat_free_context(outFmt);
            swr_free(&swr);
            avcodec_free_context(&decCtx);
            avformat_close_input(&inFmt);
            return msg;
        }

        LOGW("avcodec_open2 failed for encoder %s: %s. Trying alternatives.", encoder->name, errbuf);

        // Try each supported sample format (for non-MP3 encoders that may accept multiple formats)
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
                const char *sfname = av_get_sample_fmt_name(encCtx->sample_fmt);
                if (sfname) av_dict_set(&try_opts, "sample_fmt", sfname, 0);
                int r = avcodec_open2(encCtx, encoder, &try_opts);
                if (r >= 0) {
                    if (try_opts) av_dict_free(&try_opts);
                    ret = r;
                    break;
                }
                if (try_opts) av_dict_free(&try_opts);
            }
        }

        // Last resort: try S16 then S16P (for FLAC etc.)
        if (ret < 0) {
            AVSampleFormat fallbacks[] = { AV_SAMPLE_FMT_S16, AV_SAMPLE_FMT_S16P };
            for (int fi = 0; fi < 2 && ret < 0; ++fi) {
                encCtx->sample_fmt = fallbacks[fi];
                AVDictionary *try_opts = nullptr;
                snprintf(tmpbuf, sizeof(tmpbuf), "%d", encCtx->ch_layout.nb_channels > 0 ? encCtx->ch_layout.nb_channels : 1);
                av_dict_set(&try_opts, "channels", tmpbuf, 0);
                snprintf(tmpbuf, sizeof(tmpbuf), "%d", encCtx->sample_rate);
                av_dict_set(&try_opts, "sample_rate", tmpbuf, 0);
                if (encCtx->bit_rate > 0) { snprintf(tmpbuf, sizeof(tmpbuf), "%d", (int)encCtx->bit_rate); av_dict_set(&try_opts, "bit_rate", tmpbuf, 0); }
                const char *sfname = av_get_sample_fmt_name(encCtx->sample_fmt);
                if (sfname) av_dict_set(&try_opts, "sample_fmt", sfname, 0);
                int r = avcodec_open2(encCtx, encoder, &try_opts);
                if (r >= 0) {
                    if (try_opts) av_dict_free(&try_opts);
                    ret = r;
                    break;
                }
                if (try_opts) av_dict_free(&try_opts);
            }
        }

        if (ret < 0) {
            char eb[256]; av_strerror(ret, eb, sizeof(eb));
            std::string msg = std::string("Failed to open encoder: ") + eb;
            avcodec_free_context(&encCtx);
            avformat_free_context(outFmt);
            swr_free(&swr);
            avcodec_free_context(&decCtx);
            avformat_close_input(&inFmt);
            return msg;
        }
    }

    if (avcodec_parameters_from_context(outStream->codecpar, encCtx) < 0) {
        avcodec_free_context(&encCtx);
        avformat_free_context(outFmt);
        swr_free(&swr);
        avcodec_free_context(&decCtx);
        avformat_close_input(&inFmt);
        return std::string("Failed to set output stream parameters");
    }

    if (!(outFmt->oformat->flags & AVFMT_NOFILE)) {
        if (avio_open(&outFmt->pb, outputPath, AVIO_FLAG_WRITE) < 0) {
            avcodec_free_context(&encCtx);
            avformat_free_context(outFmt);
            swr_free(&swr);
            avcodec_free_context(&decCtx);
            avformat_close_input(&inFmt);
            return std::string("Failed to open output file for writing");
        }
    }

    if (avformat_write_header(outFmt, nullptr) < 0) {
        if (!(outFmt->oformat->flags & AVFMT_NOFILE)) avio_closep(&outFmt->pb);
        avcodec_free_context(&encCtx);
        avformat_free_context(outFmt);
        swr_free(&swr);
        avcodec_free_context(&decCtx);
        avformat_close_input(&inFmt);
        return std::string("Failed to write output header");
    }

    AVPacket* pkt = av_packet_alloc();
    AVFrame* frame = av_frame_alloc();
    AVFrame* resampled = av_frame_alloc();
    // Match encoder format/rate
    resampled->format = encCtx->sample_fmt;
    resampled->sample_rate = encCtx->sample_rate;
    // ensure resampled frame has encoder channel layout
    if (av_channel_layout_copy(&resampled->ch_layout, &encCtx->ch_layout) < 0) {
        av_frame_free(&frame);
        av_frame_free(&resampled);
        av_packet_free(&pkt);
        avcodec_free_context(&encCtx);
        avformat_free_context(outFmt);
        avcodec_free_context(&decCtx);
        avformat_close_input(&inFmt);
        return std::string("Failed to set resampled channel layout");
    }

    // Initialize resampler to convert from decoder format -> chosen encoder format
    AVChannelLayout in_ch_layout2{};
    if (inStream->codecpar->ch_layout.nb_channels) {
        if (av_channel_layout_copy(&in_ch_layout2, &inStream->codecpar->ch_layout) < 0) {
            av_channel_layout_uninit(&resampled->ch_layout);
            av_frame_free(&frame);
            av_frame_free(&resampled);
            av_packet_free(&pkt);
            avcodec_free_context(&encCtx);
            avformat_free_context(outFmt);
            swr_free(&swr);
            avcodec_free_context(&decCtx);
            avformat_close_input(&inFmt);
            return std::string("Failed to copy input channel layout");
        }
    } else {
        if (av_channel_layout_copy(&in_ch_layout2, &decCtx->ch_layout) < 0) {
            av_channel_layout_uninit(&resampled->ch_layout);
            av_frame_free(&frame);
            av_frame_free(&resampled);
            av_packet_free(&pkt);
            avcodec_free_context(&encCtx);
            avformat_free_context(outFmt);
            swr_free(&swr);
            avcodec_free_context(&decCtx);
            avformat_close_input(&inFmt);
            return std::string("Failed to init input channel layout");
        }
    }
    if (swr_alloc_set_opts2(&swr,
            &encCtx->ch_layout, encCtx->sample_fmt, encCtx->sample_rate,
            &in_ch_layout2, (AVSampleFormat)decCtx->sample_fmt, decCtx->sample_rate,
            0, nullptr) < 0 || !swr) {
        av_channel_layout_uninit(&in_ch_layout2);
        if (swr) swr_free(&swr);
        av_channel_layout_uninit(&resampled->ch_layout);
        av_frame_free(&frame);
        av_frame_free(&resampled);
        av_packet_free(&pkt);
        avcodec_free_context(&encCtx);
        avformat_free_context(outFmt);
        avcodec_free_context(&decCtx);
        avformat_close_input(&inFmt);
        return std::string("Failed to initialize resampler");
    }
    {
        int initRet = swr_init(swr);
        if (initRet < 0) {
            char errbuf[256];
            av_strerror(initRet, errbuf, sizeof(errbuf));
            LOGE("convertToFormat: swr_init failed: %s", errbuf);
            av_channel_layout_uninit(&in_ch_layout2);
            swr_free(&swr);
            av_channel_layout_uninit(&resampled->ch_layout);
            av_frame_free(&frame);
            av_frame_free(&resampled);
            av_packet_free(&pkt);
            avcodec_free_context(&encCtx);
            avformat_free_context(outFmt);
            avcodec_free_context(&decCtx);
            avformat_close_input(&inFmt);
            return std::string("Failed to initialize resampler (swr_init)");
        }
    }
    av_channel_layout_uninit(&in_ch_layout2);

    int totalDecodedFrames = 0;
    int totalFramesSent = 0;
    int totalPacketsFromEncoder = 0;
    int flushPackets = 0;
    int64_t encoder_pts = 0;

    // Many encoders prefer / require a specific frame size (nb_samples) when using send_frame().
    // MP3 (libshine) requires 1152 samples per frame.
    // For others (e.g. FLAC), use encCtx->frame_size when available; otherwise use a conservative default.
    const int default_frame_size = 1024;
    const int enc_frame_size =
        (codec_id == AV_CODEC_ID_MP3) ? 1152 :
        (encCtx->frame_size > 0 ? encCtx->frame_size : default_frame_size);
    int out_ch2 = encCtx->ch_layout.nb_channels;
    if (out_ch2 <= 0) out_ch2 = 1;
    int bytes_per_sample = av_get_bytes_per_sample(encCtx->sample_fmt);

    // Accumulation buffer for resampled samples. Use read offset to avoid O(n²) memmove;
    // compact only when offset exceeds threshold.
    std::vector<uint8_t> accumBuf;
    size_t accumReadOffset = 0;  // bytes consumed from start (avoids O(n²) memmove)
    const int bytesPerFrame = bytes_per_sample * out_ch2;
    int accumSamples = 0;

    const size_t kCompactThreshold = 256 * 1024;  // compact when read offset exceeds 256 KB

    auto maybeCompact = [&]() {
        if (accumReadOffset == 0) return;
        if (accumReadOffset < kCompactThreshold && accumReadOffset * 2 < accumBuf.size()) return;
        size_t valid = accumBuf.size() - accumReadOffset;
        if (valid > 0) memmove(accumBuf.data(), accumBuf.data() + accumReadOffset, valid);
        accumBuf.resize(valid);
        accumReadOffset = 0;
    };

    // Helper lambda: send exactly enc_frame_size samples from accumBuf to encoder
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

            // Send to encoder with EAGAIN handling
            for (;;) {
                int ret = avcodec_send_frame(encCtx, ef);
                if (ret == 0) break;
                if (ret == AVERROR(EAGAIN)) {
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
                LOGW("convertToFormat: send_frame ret=%d frame=%d pts=%lld nb=%d", ret, totalFramesSent, (long long)ef->pts, toSend);
                break;
            }
            // Drain any ready packets
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
            totalFramesSent++;

            if (!sendPartial && accumSamples < needed) break;
        }
    };

    while (av_read_frame(inFmt, pkt) >= 0) {
        if (pkt->stream_index == audioStreamIndex) {
            if (avcodec_send_packet(decCtx, pkt) == 0) {
                while (avcodec_receive_frame(decCtx, frame) == 0) {
                    totalDecodedFrames++;
                    int in_sr2 = inStream->codecpar->sample_rate ? inStream->codecpar->sample_rate : decCtx->sample_rate;
                    int64_t out_nb_samples = av_rescale_rnd(swr_get_delay(swr, in_sr2) + frame->nb_samples, encCtx->sample_rate, in_sr2, AV_ROUND_UP);
                    uint8_t** outData = nullptr;
                    if (av_samples_alloc_array_and_samples(&outData, nullptr, out_ch2, (int)out_nb_samples, encCtx->sample_fmt, 0) < 0) {
                        av_packet_unref(pkt);
                        continue;
                    }
                    int converted = swr_convert(swr, outData, (int)out_nb_samples, (const uint8_t**)frame->data, frame->nb_samples);
                    if (converted <= 0) {
                        av_freep(&outData[0]);
                        av_freep(&outData);
                        continue;
                    }


                    int newBytes = converted * bytes_per_sample * out_ch2;
                    maybeCompact();
                    size_t oldSize = accumBuf.size();
                    accumBuf.resize(oldSize + (size_t)newBytes);
                    memcpy(accumBuf.data() + oldSize, outData[0], (size_t)newBytes);
                    accumSamples += converted;

                    av_freep(&outData[0]);
                    av_freep(&outData);
                    av_frame_unref(frame);

                    flushAccumFrames(false);
                }
            }
        }
        av_packet_unref(pkt);
    }

    // Drain any remaining samples in swr (resampler delay)
    {
        uint8_t** tailData = nullptr;
        int tailCap = swr_get_delay(swr, encCtx->sample_rate) + 256;
        if (tailCap > 0 && av_samples_alloc_array_and_samples(&tailData, nullptr, out_ch2, tailCap, encCtx->sample_fmt, 0) >= 0) {
            int tailConverted = swr_convert(swr, tailData, tailCap, nullptr, 0);
            if (tailConverted > 0) {
                int tailBytes = tailConverted * bytes_per_sample * out_ch2;
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
    // Send remaining (partial) frames
    flushAccumFrames(true);

    (void)totalDecodedFrames; (void)totalPacketsFromEncoder;

    // Flush encoder
    avcodec_send_frame(encCtx, nullptr);
    AVPacket* outPkt2 = av_packet_alloc();
    while (avcodec_receive_packet(encCtx, outPkt2) == 0) {
        flushPackets++;
        outPkt2->stream_index = outStream->index;
        av_packet_rescale_ts(outPkt2, encCtx->time_base, outStream->time_base);
        av_interleaved_write_frame(outFmt, outPkt2);
        av_packet_unref(outPkt2);
    }
    av_packet_free(&outPkt2);
    (void)flushPackets;

    av_write_trailer(outFmt);
    if (!(outFmt->oformat->flags & AVFMT_NOFILE)) avio_closep(&outFmt->pb);

    struct stat stOut = {};
    long outputSizeBytes = (stat(outputPath, &stOut) == 0 && S_ISREG(stOut.st_mode)) ? (long)stOut.st_size : -1;
    LOGI("convertToFormat: done outputPath=%s outputSizeBytes=%ld", outputPath ? outputPath : "(null)", outputSizeBytes);

    av_packet_free(&pkt);
    av_frame_free(&frame);
    av_channel_layout_uninit(&resampled->ch_layout);
    av_frame_free(&resampled);

    swr_free(&swr);
    avcodec_free_context(&encCtx);
    avformat_free_context(outFmt);
    avcodec_free_context(&decCtx);
    avformat_close_input(&inFmt);

    return std::string("");
#else
    (void)inputPath; (void)outputPath; (void)formatHint;
    return std::string("FFmpeg not available. Build prebuilts with third_party/ffmpeg_prebuilt/build_ffmpeg.ps1 or build_ffmpeg.sh.");
#endif
}

extern "C" {

// Called from Kotlin: SherpaOnnxModule.nativeConvertAudioToWav16k(inputPath, outputPath) -> Boolean
// or from a dedicated helper that returns an error string. We use a single JNI that returns a boolean
// and optionally pass back an error message via a separate call or out parameter.
// For simplicity we expose one method that returns a jstring: empty = success, non-empty = error message.
JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeConvertAudioToWav16k(
    JNIEnv* env,
    jobject /* this */,
    jstring inputPath,
    jstring outputPath) {
    if (inputPath == nullptr || outputPath == nullptr) {
        return env->NewStringUTF("inputPath and outputPath must be non-null");
    }
    const char* input = env->GetStringUTFChars(inputPath, nullptr);
    const char* output = env->GetStringUTFChars(outputPath, nullptr);
    if (input == nullptr || output == nullptr) {
        if (input) env->ReleaseStringUTFChars(inputPath, input);
        if (output) env->ReleaseStringUTFChars(outputPath, output);
        return env->NewStringUTF("Failed to get path strings");
    }
    std::string err = convertToWav16kMono(input, output);
    env->ReleaseStringUTFChars(inputPath, input);
    env->ReleaseStringUTFChars(outputPath, output);
    return env->NewStringUTF(err.c_str());
}

JNIEXPORT jstring JNICALL
Java_com_sherpaonnx_SherpaOnnxModule_nativeConvertAudioToFormat(
    JNIEnv* env,
    jobject /* this */,
    jstring inputPath,
    jstring outputPath,
    jstring formatHint,
    jint outputSampleRateHz) {
    if (inputPath == nullptr || outputPath == nullptr || formatHint == nullptr) {
        return env->NewStringUTF("inputPath, outputPath and formatHint must be non-null");
    }
    const char* input = env->GetStringUTFChars(inputPath, nullptr);
    const char* output = env->GetStringUTFChars(outputPath, nullptr);
    const char* fmt = env->GetStringUTFChars(formatHint, nullptr);
    if (input == nullptr || output == nullptr || fmt == nullptr) {
        if (input) env->ReleaseStringUTFChars(inputPath, input);
        if (output) env->ReleaseStringUTFChars(outputPath, output);
        if (fmt) env->ReleaseStringUTFChars(formatHint, fmt);
        return env->NewStringUTF("Failed to get path/format strings");
    }

    std::string err = convertToFormat(input, output, fmt, (int)outputSampleRateHz);

    env->ReleaseStringUTFChars(inputPath, input);
    env->ReleaseStringUTFChars(outputPath, output);
    env->ReleaseStringUTFChars(formatHint, fmt);

    return env->NewStringUTF(err.c_str());
}

}  // extern "C"
