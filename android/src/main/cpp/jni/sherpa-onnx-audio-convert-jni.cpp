// JNI for converting arbitrary audio files to WAV 16 kHz mono 16-bit PCM (sherpa-onnx input format).
// When HAVE_FFMPEG is defined (CMake), FFmpeg prebuilts are linked and conversion is available.
// When not defined, nativeConvertAudioToWav16k returns failure with "FFmpeg not available".

#include <android/log.h>
#include <jni.h>
#include <string>

#define LOG_TAG "AudioConvertJNI"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
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
        if (swr) swr_free(&swr);
        avcodec_free_context(&decCtx);
        avformat_close_input(&inFmt);
        return std::string("Failed to initialize resampler");
    }

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
static std::string convertToFormat(const char* inputPath, const char* outputPath, const char* formatHint) {
#ifdef HAVE_FFMPEG
    // For now, if formatHint == "wav" we use convertToWav16kMono. For other formats attempt to use encoder by codec id.
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

    const AVCodec* encoder = avcodec_find_encoder(codec_id);
    if (!encoder) {
        avformat_free_context(outFmt);
        swr_free(&swr);
        avcodec_free_context(&decCtx);
        avformat_close_input(&inFmt);
        return std::string("Requested encoder not available in this build");
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
    encCtx->sample_rate = inStream->codecpar->sample_rate ? inStream->codecpar->sample_rate : decCtx->sample_rate;

    // Choose encoder sample_fmt: prefer decoder format if supported, otherwise pick first supported.
    AVSampleFormat desired_fmt = decCtx->sample_fmt;
    AVSampleFormat chosen_fmt = AV_SAMPLE_FMT_NONE;
    // Use modern API: avcodec_get_supported_config to query supported sample formats
    const void *out_configs = nullptr;
    int out_num = 0;
    if (avcodec_get_supported_config(decCtx, encoder, AV_CODEC_CONFIG_SAMPLE_FORMAT, 0, &out_configs, &out_num) >= 0 && out_configs) {
        const AVSampleFormat *fmts = (const AVSampleFormat *)out_configs;
        for (int i = 0; i < out_num; ++i) {
            if (fmts[i] == desired_fmt) {
                chosen_fmt = desired_fmt;
                break;
            }
        }
        if (chosen_fmt == AV_SAMPLE_FMT_NONE && out_num > 0) {
            chosen_fmt = fmts[0];
        }
    }
    if (chosen_fmt == AV_SAMPLE_FMT_NONE) chosen_fmt = AV_SAMPLE_FMT_S16;
    encCtx->sample_fmt = chosen_fmt;

    // Set a sensible default bitrate for compressed codecs
    if (codec_id == AV_CODEC_ID_MP3 || codec_id == AV_CODEC_ID_AAC) encCtx->bit_rate = 128000;
    else encCtx->bit_rate = 0; // lossless or PCM may ignore

    if (outFmt->oformat->flags & AVFMT_GLOBALHEADER) encCtx->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;

    if (avcodec_open2(encCtx, encoder, nullptr) < 0) {
        avcodec_free_context(&encCtx);
        avformat_free_context(outFmt);
        swr_free(&swr);
        avcodec_free_context(&decCtx);
        avformat_close_input(&inFmt);
        return std::string("Failed to open encoder");
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
        avcodec_free_context(&encCtx);
        avformat_free_context(outFmt);
        avcodec_free_context(&decCtx);
        avformat_close_input(&inFmt);
        return std::string("Failed to set resampled channel layout");
    }

    // Initialize resampler to convert from decoder format -> chosen encoder format
    AVChannelLayout in_ch_layout2;
    if (inStream->codecpar->ch_layout.nb_channels) {
        if (av_channel_layout_copy(&in_ch_layout2, &inStream->codecpar->ch_layout) < 0) {
            avcodec_free_context(&encCtx);
            avformat_free_context(outFmt);
            swr_free(&swr);
            avcodec_free_context(&decCtx);
            avformat_close_input(&inFmt);
            return std::string("Failed to copy input channel layout");
        }
    } else {
        if (av_channel_layout_copy(&in_ch_layout2, &decCtx->ch_layout) < 0) {
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
        if (swr) swr_free(&swr);
        avcodec_free_context(&encCtx);
        avformat_free_context(outFmt);
        avcodec_free_context(&decCtx);
        avformat_close_input(&inFmt);
        return std::string("Failed to initialize resampler");
    }

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
    jstring formatHint) {
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

    std::string err = convertToFormat(input, output, fmt);

    env->ReleaseStringUTFChars(inputPath, input);
    env->ReleaseStringUTFChars(outputPath, output);
    env->ReleaseStringUTFChars(formatHint, fmt);

    return env->NewStringUTF(err.c_str());
}

}  // extern "C"
