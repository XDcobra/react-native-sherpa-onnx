// JNI for converting arbitrary audio files to WAV 16 kHz mono 16-bit PCM (sherpa-onnx input format).
// When HAVE_FFMPEG is defined (CMake), FFmpeg prebuilts are linked and conversion is available.
// When not defined, nativeConvertAudioToWav16k returns failure with "FFmpeg not available".

#include <android/log.h>
#include <jni.h>
#include <string>

#define LOG_TAG "AudioConvertJNI"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

#ifdef HAVE_FFMPEG
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/opt.h>
#include <libswresample/swresample.h>
}
#include <cstdio>
#include <vector>
#endif

// Returns empty string on success, or error message on failure.
// Output is always 16 kHz mono 16-bit PCM (sherpa-onnx requirement). Input can be any rate; we resample to 16k.
static std::string convertToWav16kMono(const char* inputPath, const char* outputPath) {
#ifdef HAVE_FFMPEG
    // Implement a basic decode -> resample -> write WAV pipeline using libav* APIs.
    av_log_set_level(AV_LOG_ERROR);

    AVFormatContext* inFmt = nullptr;
    if (avformat_open_input(&inFmt, inputPath, nullptr, nullptr) < 0) {
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

    // Prepare resampler to 16k mono s16 using AVChannelLayout helpers
    SwrContext* swr = nullptr;
    AVChannelLayout out_ch_layout = AV_CHANNEL_LAYOUT_MONO;
    AVChannelLayout in_ch_layout;
    // Prefer codecpar ch_layout when available, otherwise fall back to decoder ctx
    if (inStream->codecpar->ch_layout.nb_channels) {
        if (av_channel_layout_copy(&in_ch_layout, &inStream->codecpar->ch_layout) < 0) {
            avcodec_free_context(&decCtx);
            avformat_close_input(&inFmt);
            return std::string("Failed to copy input channel layout");
        }
    } else {
        if (av_channel_layout_copy(&in_ch_layout, &decCtx->ch_layout) < 0) {
            avcodec_free_context(&decCtx);
            avformat_close_input(&inFmt);
            return std::string("Failed to initialize input channel layout");
        }
    }
    if (swr_alloc_set_opts2(&swr,
            &out_ch_layout, AV_SAMPLE_FMT_S16, 16000,
            &in_ch_layout, (AVSampleFormat)decCtx->sample_fmt, decCtx->sample_rate,
            0, nullptr) < 0 || !swr) {
        av_channel_layout_uninit(&in_ch_layout);
        if (swr) swr_free(&swr);
        avcodec_free_context(&decCtx);
        avformat_close_input(&inFmt);
        return std::string("Failed to initialize resampler");
    }
    av_channel_layout_uninit(&in_ch_layout);

    // Prepare output WAV via avformat
    AVFormatContext* outFmt = nullptr;
    if (avformat_alloc_output_context2(&outFmt, nullptr, nullptr, outputPath) < 0 || !outFmt) {
        swr_free(&swr);
        avcodec_free_context(&decCtx);
        avformat_close_input(&inFmt);
        return std::string("Failed to allocate output context");
    }

    const AVCodec* pcmCodec = avcodec_find_encoder(AV_CODEC_ID_PCM_S16LE);
    if (!pcmCodec) {
        avformat_free_context(outFmt);
        swr_free(&swr);
        avcodec_free_context(&decCtx);
        avformat_close_input(&inFmt);
        return std::string("PCM encoder not found");
    }

    AVStream* outStream = avformat_new_stream(outFmt, nullptr);
    if (!outStream) {
        avformat_free_context(outFmt);
        swr_free(&swr);
        avcodec_free_context(&decCtx);
        avformat_close_input(&inFmt);
        return std::string("Failed to create output stream");
    }

    AVCodecContext* encCtx = avcodec_alloc_context3(pcmCodec);
    // Configure encoder context for mono 16k s16 output
    AVChannelLayout mono_layout = AV_CHANNEL_LAYOUT_MONO;
    if (!encCtx) {
        avformat_free_context(outFmt);
        swr_free(&swr);
        avcodec_free_context(&decCtx);
        avformat_close_input(&inFmt);
        return std::string("Failed to allocate encoder context");
    }
    if (av_channel_layout_copy(&encCtx->ch_layout, &mono_layout) < 0) {
        avcodec_free_context(&encCtx);
        avformat_free_context(outFmt);
        swr_free(&swr);
        avcodec_free_context(&decCtx);
        avformat_close_input(&inFmt);
        return std::string("Failed to set encoder channel layout");
    }
    encCtx->sample_rate = 16000;
    encCtx->sample_fmt = AV_SAMPLE_FMT_S16;
    encCtx->bit_rate = 16 * 16000; // rough

    if (outFmt->oformat->flags & AVFMT_GLOBALHEADER) encCtx->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;

    if (avcodec_open2(encCtx, pcmCodec, nullptr) < 0) {
        avcodec_free_context(&encCtx);
        avformat_free_context(outFmt);
        swr_free(&swr);
        avcodec_free_context(&decCtx);
        avformat_close_input(&inFmt);
        return std::string("Failed to open PCM encoder");
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
    // Configure resampled frame metadata
    resampled->format = AV_SAMPLE_FMT_S16;
    resampled->sample_rate = 16000;
    // set channel layout on frame
    AVChannelLayout out_ch_layout_local = AV_CHANNEL_LAYOUT_MONO;
    if (av_channel_layout_copy(&resampled->ch_layout, &out_ch_layout_local) < 0) {
        av_frame_free(&frame);
        av_frame_free(&resampled);
        swr_free(&swr);
        avcodec_free_context(&decCtx);
        avformat_close_input(&inFmt);
        return std::string("Failed to set resampled frame channel layout");
    }

    // Buffer for resampled data will be allocated per needed samples

    while (av_read_frame(inFmt, pkt) >= 0) {
        if (pkt->stream_index == audioStreamIndex) {
            if (avcodec_send_packet(decCtx, pkt) == 0) {
                while (avcodec_receive_frame(decCtx, frame) == 0) {
                    // Resample
                    int in_sr = inStream->codecpar->sample_rate ? inStream->codecpar->sample_rate : decCtx->sample_rate;
                    int64_t out_nb_samples = av_rescale_rnd(swr_get_delay(swr, in_sr) + frame->nb_samples, 16000, in_sr, AV_ROUND_UP);
                    uint8_t** outData = nullptr;
                    int out_channels = resampled->ch_layout.nb_channels;
                    if (out_channels <= 0) out_channels = 1;
                    if (av_samples_alloc_array_and_samples(&outData, nullptr, out_channels, (int)out_nb_samples, AV_SAMPLE_FMT_S16, 0) < 0) {
                        av_packet_unref(pkt);
                        continue;
                    }
                    int converted = swr_convert(swr, outData, (int)out_nb_samples, (const uint8_t**)frame->data, frame->nb_samples);
                    if (converted < 0) {
                        av_freep(&outData[0]);
                        av_freep(&outData);
                        continue;
                    }

                    // prepare frame for encoder
                    resampled->nb_samples = converted;
                    if (av_frame_get_buffer(resampled, 0) < 0) {
                        av_freep(&outData[0]);
                        av_freep(&outData);
                        continue;
                    }
                    // copy data into resampled frame
                    int bytes_per_sample = av_get_bytes_per_sample((AVSampleFormat)resampled->format);
                    int copy_size = converted * bytes_per_sample * out_channels;
                    memcpy(resampled->data[0], outData[0], copy_size);

                    // send to encoder
                    if (avcodec_send_frame(encCtx, resampled) == 0) {
                        AVPacket* outPkt = av_packet_alloc();
                        while (avcodec_receive_packet(encCtx, outPkt) == 0) {
                            outPkt->stream_index = outStream->index;
                            av_packet_rescale_ts(outPkt, encCtx->time_base, outStream->time_base);
                            av_interleaved_write_frame(outFmt, outPkt);
                            av_packet_unref(outPkt);
                        }
                        av_packet_free(&outPkt);
                    }

                    av_freep(&outData[0]);
                    av_freep(&outData);
                    av_frame_unref(resampled);
                    av_frame_unref(frame);
                }
            }
        }
        av_packet_unref(pkt);
    }

    // Flush encoder
    avcodec_send_frame(encCtx, nullptr);
    AVPacket* outPkt = av_packet_alloc();
    while (avcodec_receive_packet(encCtx, outPkt) == 0) {
        outPkt->stream_index = outStream->index;
        av_packet_rescale_ts(outPkt, encCtx->time_base, outStream->time_base);
        av_interleaved_write_frame(outFmt, outPkt);
        av_packet_unref(outPkt);
    }
    av_packet_free(&outPkt);

    av_write_trailer(outFmt);
    if (!(outFmt->oformat->flags & AVFMT_NOFILE)) avio_closep(&outFmt->pb);

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
    (void)inputPath;
    (void)outputPath;
    return "FFmpeg not available. Build prebuilts with third_party/ffmpeg_prebuilt/build_ffmpeg.ps1 or build_ffmpeg.sh.";
#endif
}

// Generic conversion: supports writing WAV/MP3/FLAC depending on output file extension and linked encoders.
// WAV path always uses convertToWav16kMono (16 kHz mono out for sherpa-onnx). outputSampleRateHz is only used for MP3 (libshine: 32000/44100/48000); 0 = default 44100.
static std::string convertToFormat(const char* inputPath, const char* outputPath, const char* formatHint, int outputSampleRateHz) {
#ifdef HAVE_FFMPEG
    // WAV output is always 16 kHz mono via convertToWav16kMono (sherpa-onnx). Input WAV at 16k is resampled 16k->16k (no change).
    std::string fmt(formatHint ? formatHint : "");
    if (fmt == "wav" || fmt == "wav16k") {
        return convertToWav16kMono(inputPath, outputPath);
    }

    // Try to determine codec id from format hint
    AVCodecID codec_id = AV_CODEC_ID_NONE;
    if (fmt == "mp3") codec_id = AV_CODEC_ID_MP3;
    else if (fmt == "flac") codec_id = AV_CODEC_ID_FLAC;
    else {
        // fallback to WAV
        return convertToWav16kMono(inputPath, outputPath);
    }

    // The implementation for generic encoding uses the same decode+resample pipeline
    // but selects encoder by codec_id and creates an output container based on file extension.
    // For brevity we reuse much of the WAV path but change encoder selection.

    // Open input
    AVFormatContext* inFmt = nullptr;
    if (avformat_open_input(&inFmt, inputPath, nullptr, nullptr) < 0) {
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

    // Log supported sample formats
    if (fmt_configs && fmt_num > 0) {
        const AVSampleFormat *fmts = (const AVSampleFormat *)fmt_configs;
        for (int i = 0; i < fmt_num; ++i) {
            const char *name = av_get_sample_fmt_name(fmts[i]);
            LOGI("encoder supported fmt[%d]=%s", i, name ? name : "?");
        }
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
            LOGI("encoder supported sample_rate[%d]=%d", i, srs[i]);
            if (srs[i] == encCtx->sample_rate) { pick_sr = srs[i]; break; }
        }
        if (pick_sr == 0) pick_sr = srs[0];
        encCtx->sample_rate = pick_sr;
    }
    // libshine only supports 32000, 44100, 48000 Hz. Use outputSampleRateHz if valid (32000/44100/48000), else default 44100.
    if (codec_id == AV_CODEC_ID_MP3) {
        int want = (outputSampleRateHz == 32000 || outputSampleRateHz == 44100 || outputSampleRateHz == 48000) ? outputSampleRateHz : 44100;
        if (encCtx->sample_rate != want) {
            LOGI("libshine: setting sample_rate %d (requested %d)", want, outputSampleRateHz);
            encCtx->sample_rate = want;
        }
    }

    // If supported channel layouts given, prefer matching channels else pick first
    if (chl_configs && chl_num > 0) {
        const AVChannelLayout *layouts = (const AVChannelLayout *)chl_configs;
        int pick_nb = 0;
        for (int i = 0; i < chl_num; ++i) {
            const AVChannelLayout *l = &layouts[i];
            char buf[128];
            av_channel_layout_describe(l, buf, sizeof(buf));
            LOGI("encoder supported ch_layout[%d]=%s nb_channels=%d", i, buf, l->nb_channels);
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
    av_channel_layout_uninit(&in_ch_layout2);

    while (av_read_frame(inFmt, pkt) >= 0) {
        if (pkt->stream_index == audioStreamIndex) {
            if (avcodec_send_packet(decCtx, pkt) == 0) {
                while (avcodec_receive_frame(decCtx, frame) == 0) {
                    int in_sr2 = inStream->codecpar->sample_rate ? inStream->codecpar->sample_rate : decCtx->sample_rate;
                    int64_t out_nb_samples = av_rescale_rnd(swr_get_delay(swr, in_sr2) + frame->nb_samples, encCtx->sample_rate, in_sr2, AV_ROUND_UP);
                    uint8_t** outData = nullptr;
                    int out_ch2 = encCtx->ch_layout.nb_channels;
                    if (out_ch2 <= 0) out_ch2 = 1;
                    if (av_samples_alloc_array_and_samples(&outData, nullptr, out_ch2, (int)out_nb_samples, encCtx->sample_fmt, 0) < 0) {
                        av_packet_unref(pkt);
                        continue;
                    }
                    int converted = swr_convert(swr, outData, (int)out_nb_samples, (const uint8_t**)frame->data, frame->nb_samples);
                    if (converted < 0) {
                        av_freep(&outData[0]);
                        av_freep(&outData);
                        continue;
                    }

                    resampled->nb_samples = converted;
                    if (av_frame_get_buffer(resampled, 0) < 0) {
                        av_freep(&outData[0]);
                        av_freep(&outData);
                        continue;
                    }
                    int bytes_per_sample = av_get_bytes_per_sample((AVSampleFormat)resampled->format);
                    int copy_size2 = converted * bytes_per_sample * out_ch2;
                    memcpy(resampled->data[0], outData[0], copy_size2);

                    if (avcodec_send_frame(encCtx, resampled) == 0) {
                        AVPacket* outPkt = av_packet_alloc();
                        while (avcodec_receive_packet(encCtx, outPkt) == 0) {
                            outPkt->stream_index = outStream->index;
                            av_packet_rescale_ts(outPkt, encCtx->time_base, outStream->time_base);
                            av_interleaved_write_frame(outFmt, outPkt);
                            av_packet_unref(outPkt);
                        }
                        av_packet_free(&outPkt);
                    }

                    av_freep(&outData[0]);
                    av_freep(&outData);
                    av_frame_unref(resampled);
                    av_frame_unref(frame);
                }
            }
        }
        av_packet_unref(pkt);
    }

    // Flush encoder
    avcodec_send_frame(encCtx, nullptr);
    AVPacket* outPkt2 = av_packet_alloc();
    while (avcodec_receive_packet(encCtx, outPkt2) == 0) {
        outPkt2->stream_index = outStream->index;
        av_packet_rescale_ts(outPkt2, encCtx->time_base, outStream->time_base);
        av_interleaved_write_frame(outFmt, outPkt2);
        av_packet_unref(outPkt2);
    }
    av_packet_free(&outPkt2);

    av_write_trailer(outFmt);
    if (!(outFmt->oformat->flags & AVFMT_NOFILE)) avio_closep(&outFmt->pb);

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
