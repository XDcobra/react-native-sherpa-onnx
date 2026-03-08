#import "SherpaOnnxAudioConvert.h"
#import <React/RCTLog.h>
#include <string>
#include <sys/stat.h>

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
    else if (fmt == "m4a" || fmt == "aac") codec_id = AV_CODEC_ID_AAC;
    else if (fmt == "opus" || fmt == "oggm" || fmt == "ogg" || fmt == "webm" || fmt == "mkv") codec_id = AV_CODEC_ID_OPUS;
    else codec_id = AV_CODEC_ID_PCM_S16LE;

    struct stat stIn = {};
    long inputSizeBytes = (stat(inputPath, &stIn) == 0 && S_ISREG(stIn.st_mode)) ? (long)stIn.st_size : -1;
    RCTLogInfo(@"[SherpaOnnxAudioConvert] convertToFormat: input=%s size=%ld format=%s output=%s",
               inputPath ? inputPath : "(null)", inputSizeBytes, formatHint ? formatHint : "", outputPath ? outputPath : "(null)");

    // Open input
    AVFormatContext* inFmt = nullptr;
    if (avformat_open_input(&inFmt, inputPath, nullptr, nullptr) < 0) {
        RCTLogError(@"[SherpaOnnxAudioConvert] Failed to open input file: inputPath=%s", inputPath ? inputPath : "(null)");
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
        encoder = avcodec_find_encoder_by_name("libshine");
        if (!encoder) {
            avformat_free_context(outFmt);
            swr_free(&swr);
            avcodec_free_context(&decCtx);
            avformat_close_input(&inFmt);
            return std::string("libshine encoder not available in this build");
        }
    } else if (codec_id == AV_CODEC_ID_OPUS) {
        encoder = avcodec_find_encoder_by_name("libopus");
        if (!encoder) {
            avformat_free_context(outFmt);
            swr_free(&swr);
            avcodec_free_context(&decCtx);
            avformat_close_input(&inFmt);
            return std::string("libopus encoder not available in this build");
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

    if (codec_id == AV_CODEC_ID_MP3) {
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

    encCtx->sample_rate = inStream->codecpar->sample_rate ? inStream->codecpar->sample_rate : decCtx->sample_rate;

    if (isWav) {
        encCtx->sample_rate = 16000;
        encCtx->sample_fmt = AV_SAMPLE_FMT_S16;
        av_channel_layout_uninit(&encCtx->ch_layout);
        AVChannelLayout mono = AV_CHANNEL_LAYOUT_MONO;
        av_channel_layout_copy(&encCtx->ch_layout, &mono);
    }

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
        for (int i = 0; i < fmt_num; ++i) if (fmts[i] == AV_SAMPLE_FMT_S16) { chosen_fmt = AV_SAMPLE_FMT_S16; break; }
        if (chosen_fmt == AV_SAMPLE_FMT_NONE && codec_id == AV_CODEC_ID_MP3) {
            for (int i = 0; i < fmt_num; ++i) if (fmts[i] == AV_SAMPLE_FMT_S16P) { chosen_fmt = AV_SAMPLE_FMT_S16P; break; }
        }
        if (chosen_fmt == AV_SAMPLE_FMT_NONE) {
            for (int i = 0; i < fmt_num; ++i) if (fmts[i] == decCtx->sample_fmt) { chosen_fmt = decCtx->sample_fmt; break; }
        }
        if (chosen_fmt == AV_SAMPLE_FMT_NONE && fmt_num > 0) chosen_fmt = fmts[0];
    } else {
        // If not MP3, try to use S16 (standard). If AAC, it might prefer FLTP, which `chosen_fmt = fmts[0]` captures below.
        chosen_fmt = (codec_id == AV_CODEC_ID_MP3) ? AV_SAMPLE_FMT_S16P : AV_SAMPLE_FMT_S16;
    }
    encCtx->sample_fmt = chosen_fmt;

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
        if (encCtx->sample_rate != want) encCtx->sample_rate = want;
    }
    if (codec_id == AV_CODEC_ID_OPUS) {
        int want = (outputSampleRateHz == 8000 || outputSampleRateHz == 12000 || outputSampleRateHz == 16000 || outputSampleRateHz == 24000 || outputSampleRateHz == 48000) ? outputSampleRateHz : 48000;
        if (encCtx->sample_rate != want) encCtx->sample_rate = want;
    }

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

    if (codec_id == AV_CODEC_ID_MP3 || codec_id == AV_CODEC_ID_AAC || codec_id == AV_CODEC_ID_OPUS) encCtx->bit_rate = 128000;
    else encCtx->bit_rate = 0;

    if (outFmt->oformat->flags & AVFMT_GLOBALHEADER) encCtx->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;

    if (encCtx->sample_rate > 0) {
        encCtx->time_base = AVRational{1, encCtx->sample_rate};
        if (outStream) {
            outStream->time_base = encCtx->time_base;
        }
    }

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
    av_dict_free(&enc_opts);
    enc_opts = nullptr;
    if (ret < 0) {
        char errbuf[256];
        av_strerror(ret, errbuf, sizeof(errbuf));

        if (codec_id == AV_CODEC_ID_MP3) {
            std::string msg = std::string("Failed to open encoder: ") + errbuf;
            avcodec_free_context(&encCtx);
            avformat_free_context(outFmt);
            swr_free(&swr);
            avcodec_free_context(&decCtx);
            avformat_close_input(&inFmt);
            return msg;
        }

        RCTLogWarn(@"[SherpaOnnxAudioConvert] avcodec_open2 failed for encoder %s: %s. Trying alternatives.", encoder->name, errbuf);

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

        if (ret < 0) {
            // AAC encoders typically require FLTP; try that specifically.
            AVSampleFormat fallbacks[] = { AV_SAMPLE_FMT_S16, AV_SAMPLE_FMT_S16P, AV_SAMPLE_FMT_FLTP };
            for (int fi = 0; fi < 3 && ret < 0; ++fi) {
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
    resampled->format = encCtx->sample_fmt;
    resampled->sample_rate = encCtx->sample_rate;
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
            RCTLogError(@"[SherpaOnnxAudioConvert] swr_init failed: %s", errbuf);
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

    const int default_frame_size = 1024;
    const int enc_frame_size =
        (codec_id == AV_CODEC_ID_MP3) ? 1152 :
        (encCtx->frame_size > 0 ? encCtx->frame_size : default_frame_size);
    int out_ch2 = encCtx->ch_layout.nb_channels;
    if (out_ch2 <= 0) out_ch2 = 1;
    int bytes_per_sample = av_get_bytes_per_sample(encCtx->sample_fmt);

    std::vector<uint8_t> accumBuf;
    size_t accumReadOffset = 0;
    const int bytesPerFrame = bytes_per_sample * out_ch2;
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
                RCTLogWarn(@"[SherpaOnnxAudioConvert] send_frame ret=%d frame=%d pts=%lld nb=%d", ret, totalFramesSent, (long long)ef->pts, toSend);
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
    flushAccumFrames(true);

    (void)totalDecodedFrames; (void)totalPacketsFromEncoder;

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
    RCTLogInfo(@"[SherpaOnnxAudioConvert] done outputPath=%s size=%ld", outputPath ? outputPath : "(null)", outputSizeBytes);

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
    return std::string("FFmpeg not available. Build prebuilts with third_party/ffmpeg_prebuilt/build_ffmpeg_ios.sh.");
#endif
}

@implementation SherpaOnnxAudioConvert

+ (BOOL)convertAudioToWav16k:(NSString *)inputPath
                  outputPath:(NSString *)outputPath
                       error:(NSError **)error
{
    std::string err = convertToWav16kMono(inputPath.UTF8String, outputPath.UTF8String);
    if (!err.empty()) {
        if (error) {
            *error = [NSError errorWithDomain:@"SherpaOnnxAudioConvert"
                                         code:-1
                                     userInfo:@{NSLocalizedDescriptionKey: [NSString stringWithUTF8String:err.c_str()]}];
        }
        return NO;
    }
    return YES;
}

+ (BOOL)convertAudioToFormat:(NSString *)inputPath
                  outputPath:(NSString *)outputPath
                      format:(NSString *)format
          outputSampleRateHz:(int)outputSampleRateHz
                       error:(NSError **)error
{
    std::string err = convertToFormat(inputPath.UTF8String, outputPath.UTF8String, format.UTF8String, outputSampleRateHz);
    if (!err.empty()) {
        if (error) {
            *error = [NSError errorWithDomain:@"SherpaOnnxAudioConvert"
                                         code:-1
                                     userInfo:@{NSLocalizedDescriptionKey: [NSString stringWithUTF8String:err.c_str()]}];
        }
        return NO;
    }
    return YES;
}

@end
