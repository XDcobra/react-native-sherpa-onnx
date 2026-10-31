cmake_minimum_required(VERSION 3.22.1)

project("sherpaonnx")

# Set C++ standard
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ANDROID_ABI MUST be set by Gradle - it should never be empty
if(NOT ANDROID_ABI)
    message(FATAL_ERROR "ANDROID_ABI not set. This is a normal error.\n\n"
                        "How to fix:\n"
                        "  1. Use: cd example && yarn android\n"
                        "     (This runs Gradle which sets ANDROID_ABI)\n\n"
                        "  2. Or if building manually with CMake, specify:\n"
                        "     cmake -B build -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=android-24 ...\n\n"
                        "Supported ABIs: arm64-v8a, armeabi-v7a, x86, x86_64")
endif()

# Set Windows path length limit
if(WIN32)
    set(CMAKE_OBJECT_PATH_MAX 500)
endif()

# Calculate path relative to project root: android/src/main/cpp -> android -> project root
get_filename_component(PROJECT_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../.." ABSOLUTE)

find_package(ReactAndroid CONFIG QUIET)

# Optional: disable FFmpeg (gradle.properties: sherpaOnnxDisableFfmpeg=true). See docs/disable-ffmpeg.md.
set(USE_FFMPEG ON)
if(SHERPA_ONNX_DISABLE_FFMPEG)
    set(USE_FFMPEG OFF)
    message(STATUS "FFmpeg disabled (SHERPA_ONNX_DISABLE_FFMPEG=ON). convertAudioToWav16k/convertAudioToFormat and decode (non-WAV) will return an error at runtime.")
endif()

if(USE_FFMPEG)
# FFmpeg: libs and headers from (1) third_party/ffmpeg_prebuilt/android (local build) or (2) jniLibs + cpp/include/ffmpeg (GitHub release zip).
# PROJECT_ROOT = android/; repo root = PROJECT_ROOT/..
set(FFMPEG_PREBUILT_BASE "${PROJECT_ROOT}/../third_party/ffmpeg_prebuilt/android")
set(FFMPEG_PREBUILT_LIB "${FFMPEG_PREBUILT_BASE}/${ANDROID_ABI}/lib")
set(FFMPEG_JNILIBS "${PROJECT_ROOT}/src/main/jniLibs/${ANDROID_ABI}")
set(FFMPEG_INCLUDE_CPP "${PROJECT_ROOT}/src/main/cpp/include/ffmpeg")
# Require a real header — an empty third_party/.../include/ dir must not win over Gradle-populated cpp/include/ffmpeg.
if(EXISTS "${FFMPEG_PREBUILT_BASE}/include/libavcodec/avcodec.h")
    set(FFMPEG_INCLUDE_DIR "${FFMPEG_PREBUILT_BASE}/include")
    message(STATUS "FFmpeg headers: prebuilts ${FFMPEG_INCLUDE_DIR}")
elseif(EXISTS "${FFMPEG_INCLUDE_CPP}/libavcodec/avcodec.h")
    set(FFMPEG_INCLUDE_DIR "${FFMPEG_INCLUDE_CPP}")
    message(STATUS "FFmpeg headers: module tree ${FFMPEG_INCLUDE_DIR}")
else()
    message(FATAL_ERROR "FFmpeg headers missing. Either:\n"
                        "  - Build: cd third_party/ffmpeg_prebuilt && ./build_ffmpeg.sh (creates android/include)\n"
                        "  - Or use a release that includes include/ (Gradle extracts to ${FFMPEG_INCLUDE_CPP})")
endif()
# Prebuilts may be either legacy layout android/<abi>/lib/ (build_ffmpeg.sh) or
# android/jni/<abi>/ (same as Gradle THIRD_PARTY in docs/PREBUILT_RESOLUTION.md).
set(FFMPEG_PREBUILT_JNI_ABI "${FFMPEG_PREBUILT_BASE}/jni/${ANDROID_ABI}")
if(EXISTS "${FFMPEG_PREBUILT_LIB}/libavcodec.so")
    set(FFMPEG_LIB_DIR "${FFMPEG_PREBUILT_LIB}")
    message(STATUS "FFmpeg libs: prebuilts ${FFMPEG_LIB_DIR}")
elseif(EXISTS "${FFMPEG_PREBUILT_JNI_ABI}/libavcodec.so")
    set(FFMPEG_LIB_DIR "${FFMPEG_PREBUILT_JNI_ABI}")
    message(STATUS "FFmpeg libs: prebuilts (jni/<abi>) ${FFMPEG_LIB_DIR}")
elseif(EXISTS "${FFMPEG_JNILIBS}/libavcodec.so")
    set(FFMPEG_LIB_DIR "${FFMPEG_JNILIBS}")
    message(STATUS "FFmpeg libs: jniLibs ${FFMPEG_LIB_DIR}")
else()
    message(FATAL_ERROR "FFmpeg libs missing for ABI ${ANDROID_ABI}. Run a Gradle Android build so prebuilts populate jniLibs, or add local .so under jniLibs / ffmpeg prebuilts paths.")
endif()
endif(USE_FFMPEG)

# Optional: disable libarchive (gradle.properties: sherpaOnnxDisableLibarchive=true). See docs/disable-libarchive.md.
set(USE_LIBARCHIVE ON)
if(SHERPA_ONNX_DISABLE_LIBARCHIVE)
    set(USE_LIBARCHIVE OFF)
    message(STATUS "libarchive disabled (SHERPA_ONNX_DISABLE_LIBARCHIVE=ON). extractTarBz2/cancelExtractTarBz2 will return an error at runtime.")
endif()

# Optional: enable libwebp (gradle.properties: sherpaOnnxEnableLibwebp=true). Default OFF.
set(USE_LIBWEBP OFF)
if(SHERPA_ONNX_ENABLE_LIBWEBP)
    set(USE_LIBWEBP ON)
    message(STATUS "libwebp enabled (SHERPA_ONNX_ENABLE_LIBWEBP=ON).")
else()
    message(STATUS "libwebp disabled (default). Set sherpaOnnxEnableLibwebp=true to link WebP decode/encode.")
endif()

# Optional: enable PDFium (gradle.properties: sherpaOnnxEnablePdfium=true). Default OFF.
set(USE_PDFIUM OFF)
if(SHERPA_ONNX_ENABLE_PDFIUM)
    set(USE_PDFIUM ON)
    message(STATUS "PDFium enabled (SHERPA_ONNX_ENABLE_PDFIUM=ON).")
else()
    message(STATUS "PDFium disabled (default). Set sherpaOnnxEnablePdfium=true to link text-layer extract.")
endif()

# Source files by domain (see docs/NATIVE_NAMING_CONVENTION.md). model_detect: subdirs common/stt/tts/enhancement/alignment; flat #includes via multiple include paths below.
set(SOURCES
    ort/ApplyOrtProvider.cpp
    alignment/sherpa_onnx_ctc_alignment.cpp
    alignment/sherpa_onnx_alignment_engine.cpp
    jni/alignment/sherpa-onnx-alignment-jni.cpp
    jni/module/sherpa-onnx-module-jni.cpp
    jni/archive/sherpa-onnx-archive-helper.cpp
    jni/archive/sherpa-onnx-archive-jni.cpp
    jni/model_detect/common/sherpa-onnx-model-detect-helper.cpp
    jni/model_detect/common/sherpa-onnx-detect-jni-common.cpp
    jni/model_detect/common/sherpa-onnx-model-detect-unified.cpp
    jni/model_detect/common/sherpa-onnx-model-path-fill.cpp
    jni/model_detect/common/sherpa-onnx-validate-custom.cpp
    jni/model_detect/common/sherpa-onnx-unified-detect-wrapper.cpp
    jni/model_detect/common/sherpa-onnx-catalog-metadata.cpp
    jni/model_detect/common/model_language_catalog.cpp
    jni/model_detect/common/sherpa-onnx-ort-guard-utils.cpp
    jni/model_detect/stt/sherpa-onnx-stt-catalog-metadata.cpp
    jni/model_detect/stt/sherpa-onnx-model-detect-stt.cpp
    jni/model_detect/stt/sherpa-onnx-validate-stt.cpp
    jni/model_detect/stt/sherpa-onnx-validate-online-stt.cpp
    jni/model_detect/stt/sherpa-onnx-stt-wrapper.cpp
    jni/model_detect/stt/sherpa-onnx-stt-online-guard.cpp
    jni/model_detect/stt/sherpa-onnx-stt-online-guard-transducer.cpp
    jni/model_detect/stt/sherpa-onnx-stt-online-guard-paraformer.cpp
    jni/model_detect/stt/sherpa-onnx-stt-online-guard-ctc.cpp
    jni/model_detect/tts/sherpa-onnx-tts-catalog-metadata.cpp
    jni/model_detect/tts/sherpa-onnx-model-detect-tts.cpp
    jni/model_detect/tts/sherpa-onnx-validate-tts.cpp
    jni/model_detect/tts/sherpa-onnx-tts-wrapper.cpp
    jni/model_detect/enhancement/sherpa-onnx-enhancement-catalog-metadata.cpp
    jni/model_detect/enhancement/sherpa-onnx-enhancement-online-guard.cpp
    jni/model_detect/enhancement/sherpa-onnx-model-detect-enhancement.cpp
    jni/model_detect/enhancement/sherpa-onnx-validate-enhancement.cpp
    jni/model_detect/enhancement/sherpa-onnx-enhancement-wrapper.cpp
    jni/model_detect/separation/sherpa-onnx-model-detect-separation.cpp
    jni/model_detect/separation/sherpa-onnx-validate-separation.cpp
    jni/model_detect/separation/sherpa-onnx-separation-detect-wrapper.cpp
    jni/model_detect/speaker/sherpa-onnx-model-detect-speaker-embedding.cpp
    jni/model_detect/speaker/sherpa-onnx-validate-speaker-embedding.cpp
    jni/model_detect/speaker/sherpa-onnx-speaker-embedding-online-guard.cpp
    jni/model_detect/speaker/sherpa-onnx-speaker-embedding-detect-wrapper.cpp
    jni/model_detect/diarization/sherpa-onnx-model-detect-diarization.cpp
    jni/model_detect/diarization/sherpa-onnx-validate-diarization.cpp
    jni/model_detect/diarization/sherpa-onnx-diarization-detect-wrapper.cpp
    separation/sherpa-onnx-separation-wrapper.cpp
    jni/separation/sherpa-onnx-separation-jni.cpp
    diarization/powerset.cpp
    diarization/pyannote-segmentation-model.cpp
    diarization/speaker-timeline.cpp
    diarization/agglomerative-clustering.cpp
    diarization/diarization-session.cpp
    diarization/pyannote-segmentation-session.cpp
    diarization/sherpa-onnx-diarization-wrapper.cpp
    diarization/sortformer-fbank.cpp
    diarization/sortformer-post-processor.cpp
    diarization/sortformer-streaming-model.cpp
    diarization/sherpa-onnx-streaming-diarization-wrapper.cpp
    jni/diarization/sherpa-onnx-diarization-jni.cpp
    jni/segment/sherpa-onnx-pyannote-segmentation-jni.cpp
    speaker-embedding/speaker-embedding-runner.cpp
    speaker-embedding/speaker-embedding-manager.cpp
    speaker-embedding/sherpa-onnx-speaker-embedding-wrapper.cpp
    jni/speaker-embedding/sherpa-onnx-speaker-embedding-jni.cpp
    jni/model_detect/punctuation/sherpa-onnx-punctuation-catalog-metadata.cpp
    jni/model_detect/punctuation/sherpa-onnx-punctuation-online-guard.cpp
    jni/model_detect/punctuation/sherpa-onnx-model-detect-punctuation.cpp
    jni/model_detect/punctuation/sherpa-onnx-validate-punctuation.cpp
    jni/model_detect/punctuation/sherpa-onnx-punctuation-wrapper.cpp
    jni/model_detect/vad/sherpa-onnx-vad-catalog-metadata.cpp
    jni/model_detect/vad/sherpa-onnx-model-detect-vad.cpp
    jni/model_detect/vad/sherpa-onnx-validate-vad.cpp
    jni/model_detect/vad/sherpa-onnx-vad-wrapper.cpp
    jni/model_detect/alignment/sherpa-onnx-model-detect-alignment.cpp
    jni/model_detect/alignment/sherpa-onnx-validate-alignment.cpp
    jni/model_detect/alignment/sherpa-onnx-alignment-wrapper.cpp
    jni/model_detect/ocr/sherpa-onnx-model-detect-ocr.cpp
    jni/model_detect/ocr/sherpa-onnx-validate-ocr.cpp
    jni/model_detect/slid/sherpa-onnx-model-detect-slid.cpp
    jni/model_detect/slid/sherpa-onnx-validate-slid.cpp
    jni/model_detect/slid/sherpa-onnx-slid-detect-wrapper.cpp
    jni/model_detect/kws/sherpa-onnx-model-detect-kws.cpp
    jni/model_detect/kws/sherpa-onnx-validate-kws.cpp
    jni/model_detect/kws/sherpa-onnx-kws-detect-wrapper.cpp
    jni/model_detect/audio_tagging/sherpa-onnx-audio-tagging-catalog-metadata.cpp
    jni/model_detect/audio_tagging/sherpa-onnx-model-detect-audio-tagging.cpp
    jni/model_detect/audio_tagging/sherpa-onnx-validate-audio-tagging.cpp
    jni/model_detect/audio_tagging/sherpa-onnx-audio-tagging-detect-wrapper.cpp
    jni/audiobuffer/SherpaOnnxJSI.cpp
    jni/audiobuffer/SherpaOnnxJSIInstall.cpp
    jni/audio/audio_f32le_to_format.cpp
    jni/audio/AudioDecodeSession.cpp
    jni/audio/AudioVisualization.cpp
    jni/audio/FfmpegFormatGuard.cpp
    jni/audio/audio_decode_jni.cpp
    jni/audio/audio_visualization_jni.cpp
    jni/audio/AudioEncodeSession.cpp
    jni/audio/audio_encode_jni.cpp
    jni/diagnostic/NativeDiagnostic.cpp
    jni/diagnostic/NativeDiagnosticAndroid.cpp
    jni/diagnostic/native_diagnostic_jni.cpp
    crypto/sha256.cpp
    image/ImageMmapThreshold.cpp
    image/ImageRegistry.cpp
    image/ImageFileLazyBackend.cpp
    image/live/LiveImageEntry.cpp
    image/ImageFrameEncoder.cpp
    image/decode/ImageDecoder.cpp
    jni/image/sherpa-onnx-imagebuffer-jni.cpp
    jni/video/sherpa-onnx-videobuffer-jni.cpp
    ocr/OcrFactory.cpp
    ocr/OcrDetect.cpp
    ocr/OcrTextUtils.cpp
    ocr/OcrEngine.cpp
    ocr/OcrRecognizeContext.cpp
    ocr/OcrRecognizeSpec.cpp
    ocr/OcrCapabilities.cpp
    ocr/OcrGeometry.cpp
    ocr/OcrCrop.cpp
    ocr/markup/OcrTable.cpp
    ocr/markup/OcrOtsl.cpp
    ocr/markup/OcrElementKind.cpp
    ocr/OcrOrtEnv.cpp
    ocr/OcrOrtHelpers.cpp
    ocr/ppocr/PpocrBackend.cpp
    ocr/ppocr/PpocrCtcDecoder.cpp
    ocr/ppocr/PpocrDbPostprocess.cpp
    ocr/ppocr/PpocrImageOps.cpp
    ocr/doctr/DoctrBackend.cpp
    ocr/doctr/DoctrDbPostprocess.cpp
    ocr/doctr/DoctrImageOps.cpp
    ocr/doctr/DoctrManifest.cpp
    ocr/doctr/DoctrRecDecode.cpp
    ocr/doc_vlm/DocVlmBackend.cpp
    ocr/doc_vlm/DocVlmDocTags.cpp
    ocr/doc_vlm/DocVlmDocTagsPrefix.cpp
    ocr/doc_vlm/DocVlmImageOps.cpp
    ocr/doc_vlm/DocVlmManifest.cpp
    ocr/doc_vlm/DocVlmPrompt.cpp
    ocr/doc_vlm/DocVlmTokenizer.cpp
    ocr/nemotron_parse/NemotronParseBackend.cpp
    ocr/nemotron_parse/NemotronParseImageOps.cpp
    ocr/nemotron_parse/NemotronParseManifest.cpp
    ocr/nemotron_parse/NemotronParseMarkup.cpp
    ocr/nemotron_parse/NemotronParseNavit.cpp
    ocr/nemotron_parse/NemotronParseNpy.cpp
    ocr/nemotron_parse/NemotronParseTokenizer.cpp
    ocr/paddleocr_vl/PaddleocrVlBackend.cpp
    ocr/paddleocr_vl/PaddleocrVlImageOps.cpp
    ocr/paddleocr_vl/PaddleocrVlManifest.cpp
    ocr/paddleocr_vl/PaddleocrVlMarkup.cpp
    ocr/paddleocr_vl/PaddleocrVlRope.cpp
    ocr/paddleocr_vl/PaddleocrVlTokenizer.cpp
    jni/ocr/sherpa-onnx-ocr-jni.cpp
    pdf/PdfDocument.cpp
    pdf/PdfTextLayerExtractor.cpp
    pdf/PdfPageRasterizer.cpp
    pdf/PdfLazySession.cpp
    jni/pdf/sherpa-onnx-pdf-jni.cpp
    document/DocumentExtractor.cpp
    document/DocArchive.cpp
    document/DocSniff.cpp
    document/DocHtmlText.cpp
    document/DocEpub.cpp
    document/DocFb2.cpp
    document/DocComic.cpp
    document/DocMobi.cpp
    ${PROJECT_ROOT}/../third_party/pugixml/src/pugixml.cpp
    jni/document/sherpa-onnx-document-jni.cpp
    video/core/AlignedBuffer.cpp
    video/core/FileIo.cpp
    video/core/ColorConvert.cpp
    video/core/Timeline.cpp
    video/core/MemoryBudget.cpp
    video/core/FrameSlab.cpp
    video/core/DecodedFrameCache.cpp
    video/audio/AudioTimeline.cpp
    video/audio/AudioPacketReader.cpp
    video/audio/FfmpegAudioDecoder.cpp
    video/audio/VideoAudioExtractor.cpp
    video/audio/LiveAudioTap.cpp
    video/live/AudioPacketRing.cpp
    video/demux/BitstreamUtil.cpp
    video/decode/FakeDecoder.cpp
    video/decode/DecoderFactory.cpp
    video/encode/EncoderFactory.cpp
    video/encode/FakeEncoder.cpp
    video/encode/VideoExportSession.cpp
    video/decode/DecoderPool.cpp
    video/decode/DecodeSession.cpp
    video/decode/ThinningPlanner.cpp
    video/demux/FfmpegDemuxer.cpp
    video/demux/FfmpegProbe.cpp
    video/VideoEntry.cpp
    video/OfflineVideoEntry.cpp
    video/VideoRegistry.cpp
    video/VideoFrameAccess.cpp
    video/VideoPacketReader.cpp
    video/VideoImageBridge.cpp
    video/live/EncodedPacketRing.cpp
    video/live/PacketSpool.cpp
    video/live/LiveVideoEntry.cpp
    video/live/LiveIngest.cpp
    video/preview/PlaybackController.cpp
    video/preview/PlaybackClock.cpp
    video/preview/FrameScheduler.cpp
    video/preview/PreviewPlayer.cpp
    video/platform/android/MediaCodecSurfaceRenderer.cpp
    video/platform/android/JniAudioTrackRenderer.cpp
    jni/video/sherpa-onnx-videopreview-jni.cpp
    video/platform/android/AMediaCodecDecoder.cpp
    video/platform/android/AMediaCodecEncoder.cpp
)

# lexbor: prebuilt shared .so (TAG + Gradle download). No in-tree source build.
set(LEXBOR_PREBUILT_BASE "${PROJECT_ROOT}/../third_party/lexbor_prebuilt/android")
set(LEXBOR_PREBUILT_LIB "${LEXBOR_PREBUILT_BASE}/${ANDROID_ABI}/lib")
set(LEXBOR_PREBUILT_JNI_ABI "${LEXBOR_PREBUILT_BASE}/jni/${ANDROID_ABI}")
set(LEXBOR_JNILIBS "${PROJECT_ROOT}/src/main/jniLibs/${ANDROID_ABI}")
set(LEXBOR_INCLUDE_CPP "${PROJECT_ROOT}/src/main/cpp/include")
set(USE_LEXBOR_PREBUILT OFF)
if(EXISTS "${LEXBOR_PREBUILT_LIB}/liblexbor.so")
    set(USE_LEXBOR_PREBUILT ON)
    set(LEXBOR_LIB_DIR "${LEXBOR_PREBUILT_LIB}")
elseif(EXISTS "${LEXBOR_PREBUILT_JNI_ABI}/liblexbor.so")
    set(USE_LEXBOR_PREBUILT ON)
    set(LEXBOR_LIB_DIR "${LEXBOR_PREBUILT_JNI_ABI}")
elseif(EXISTS "${LEXBOR_JNILIBS}/liblexbor.so")
    set(USE_LEXBOR_PREBUILT ON)
    set(LEXBOR_LIB_DIR "${LEXBOR_JNILIBS}")
endif()
if(EXISTS "${LEXBOR_PREBUILT_BASE}/include/lexbor/html/parser.h")
    set(LEXBOR_INCLUDE_DIR "${LEXBOR_PREBUILT_BASE}/include")
elseif(EXISTS "${LEXBOR_INCLUDE_CPP}/lexbor/html/parser.h")
    set(LEXBOR_INCLUDE_DIR "${LEXBOR_INCLUDE_CPP}")
endif()
if(NOT USE_LEXBOR_PREBUILT OR NOT LEXBOR_INCLUDE_DIR)
    message(FATAL_ERROR
        "lexbor prebuilt not found (liblexbor.so + lexbor/html/parser.h). "
        "Run a Gradle Android build so prebuilts download, or publish "
        "third_party/lexbor_prebuilt (see README).")
endif()
message(STATUS "lexbor: using prebuilt (libs: ${LEXBOR_LIB_DIR}, include: ${LEXBOR_INCLUDE_DIR})")

# libyuv: prebuilt shared .so (TAG + Gradle download). No in-tree source build.
set(LIBYUV_PREBUILT_BASE "${PROJECT_ROOT}/../third_party/libyuv_prebuilt/android")
set(LIBYUV_PREBUILT_LIB "${LIBYUV_PREBUILT_BASE}/${ANDROID_ABI}/lib")
set(LIBYUV_PREBUILT_JNI_ABI "${LIBYUV_PREBUILT_BASE}/jni/${ANDROID_ABI}")
set(LIBYUV_JNILIBS "${PROJECT_ROOT}/src/main/jniLibs/${ANDROID_ABI}")
set(LIBYUV_INCLUDE_CPP "${PROJECT_ROOT}/src/main/cpp/include")
set(USE_LIBYUV_PREBUILT OFF)
if(EXISTS "${LIBYUV_PREBUILT_LIB}/libyuv.so")
    set(USE_LIBYUV_PREBUILT ON)
    set(LIBYUV_LIB_DIR "${LIBYUV_PREBUILT_LIB}")
elseif(EXISTS "${LIBYUV_PREBUILT_JNI_ABI}/libyuv.so")
    set(USE_LIBYUV_PREBUILT ON)
    set(LIBYUV_LIB_DIR "${LIBYUV_PREBUILT_JNI_ABI}")
elseif(EXISTS "${LIBYUV_JNILIBS}/libyuv.so")
    set(USE_LIBYUV_PREBUILT ON)
    set(LIBYUV_LIB_DIR "${LIBYUV_JNILIBS}")
endif()
if(EXISTS "${LIBYUV_PREBUILT_BASE}/include/libyuv/convert.h")
    set(LIBYUV_INCLUDE_DIR "${LIBYUV_PREBUILT_BASE}/include")
elseif(EXISTS "${LIBYUV_INCLUDE_CPP}/libyuv/convert.h")
    set(LIBYUV_INCLUDE_DIR "${LIBYUV_INCLUDE_CPP}")
endif()
if(NOT USE_LIBYUV_PREBUILT OR NOT LIBYUV_INCLUDE_DIR)
    message(FATAL_ERROR
        "libyuv prebuilt not found (libyuv.so + libyuv/convert.h). "
        "Run a Gradle Android build so prebuilts download, or publish "
        "third_party/libyuv_prebuilt (see README).")
endif()
message(STATUS "libyuv: using prebuilt (libs: ${LIBYUV_LIB_DIR}, include: ${LIBYUV_INCLUDE_DIR})")

if(USE_LIBARCHIVE)
# libarchive: (1) prebuilt from third_party/libarchive_prebuilt or jniLibs + cpp/include/libarchive (Maven/GitHub), or (2) build from source.
set(LIBARCHIVE_PREBUILT_BASE "${PROJECT_ROOT}/../third_party/libarchive_prebuilt/android")
set(LIBARCHIVE_PREBUILT_LIB "${LIBARCHIVE_PREBUILT_BASE}/${ANDROID_ABI}/lib")
set(LIBARCHIVE_JNILIBS "${PROJECT_ROOT}/src/main/jniLibs/${ANDROID_ABI}")
set(LIBARCHIVE_INCLUDE_CPP "${PROJECT_ROOT}/src/main/cpp/include/libarchive")
set(USE_LIBARCHIVE_PREBUILT OFF)
set(LIBARCHIVE_PREBUILT_JNI_ABI "${LIBARCHIVE_PREBUILT_BASE}/jni/${ANDROID_ABI}")
if(EXISTS "${LIBARCHIVE_PREBUILT_LIB}/libarchive.so")
    set(USE_LIBARCHIVE_PREBUILT ON)
    set(LIBARCHIVE_LIB_DIR "${LIBARCHIVE_PREBUILT_LIB}")
    if(EXISTS "${LIBARCHIVE_PREBUILT_BASE}/include/archive.h")
        set(LIBARCHIVE_INCLUDE_DIR "${LIBARCHIVE_PREBUILT_BASE}/include")
    elseif(EXISTS "${LIBARCHIVE_INCLUDE_CPP}/archive.h")
        set(LIBARCHIVE_INCLUDE_DIR "${LIBARCHIVE_INCLUDE_CPP}")
    endif()
elseif(EXISTS "${LIBARCHIVE_PREBUILT_JNI_ABI}/libarchive.so")
    set(USE_LIBARCHIVE_PREBUILT ON)
    set(LIBARCHIVE_LIB_DIR "${LIBARCHIVE_PREBUILT_JNI_ABI}")
    if(EXISTS "${LIBARCHIVE_PREBUILT_BASE}/include/archive.h")
        set(LIBARCHIVE_INCLUDE_DIR "${LIBARCHIVE_PREBUILT_BASE}/include")
    elseif(EXISTS "${LIBARCHIVE_INCLUDE_CPP}/archive.h")
        set(LIBARCHIVE_INCLUDE_DIR "${LIBARCHIVE_INCLUDE_CPP}")
    endif()
elseif(EXISTS "${LIBARCHIVE_JNILIBS}/libarchive.so")
    set(USE_LIBARCHIVE_PREBUILT ON)
    set(LIBARCHIVE_LIB_DIR "${LIBARCHIVE_JNILIBS}")
    if(EXISTS "${LIBARCHIVE_INCLUDE_CPP}/archive.h")
        set(LIBARCHIVE_INCLUDE_DIR "${LIBARCHIVE_INCLUDE_CPP}")
    endif()
endif()
if(USE_LIBARCHIVE_PREBUILT AND LIBARCHIVE_INCLUDE_DIR)
    message(STATUS "libarchive: using prebuilt (libs: ${LIBARCHIVE_LIB_DIR}, include: ${LIBARCHIVE_INCLUDE_DIR})")
else()
    message(STATUS "Building libarchive from bundled source...")
    add_subdirectory(${PROJECT_ROOT}/../third_party/libarchive ${CMAKE_BINARY_DIR}/libarchive)
    message(STATUS "libarchive built successfully")
endif()
endif(USE_LIBARCHIVE)

if(USE_LIBWEBP)
# libwebp: prebuilt from third_party/libwebp_prebuilt or jniLibs + cpp/include/webp (Maven/GitHub).
# No in-tree CMake source build here — use third_party/libwebp_prebuilt/build_libwebp_android.sh.
set(LIBWEBP_PREBUILT_BASE "${PROJECT_ROOT}/../third_party/libwebp_prebuilt/android")
set(LIBWEBP_PREBUILT_LIB "${LIBWEBP_PREBUILT_BASE}/${ANDROID_ABI}/lib")
set(LIBWEBP_PREBUILT_JNI_ABI "${LIBWEBP_PREBUILT_BASE}/jni/${ANDROID_ABI}")
set(LIBWEBP_JNILIBS "${PROJECT_ROOT}/src/main/jniLibs/${ANDROID_ABI}")
set(LIBWEBP_INCLUDE_CPP "${PROJECT_ROOT}/src/main/cpp/include/webp")
set(USE_LIBWEBP_PREBUILT OFF)
if(EXISTS "${LIBWEBP_PREBUILT_LIB}/libwebp.so")
    set(USE_LIBWEBP_PREBUILT ON)
    set(LIBWEBP_LIB_DIR "${LIBWEBP_PREBUILT_LIB}")
elseif(EXISTS "${LIBWEBP_PREBUILT_JNI_ABI}/libwebp.so")
    set(USE_LIBWEBP_PREBUILT ON)
    set(LIBWEBP_LIB_DIR "${LIBWEBP_PREBUILT_JNI_ABI}")
elseif(EXISTS "${LIBWEBP_JNILIBS}/libwebp.so")
    set(USE_LIBWEBP_PREBUILT ON)
    set(LIBWEBP_LIB_DIR "${LIBWEBP_JNILIBS}")
endif()
if(EXISTS "${LIBWEBP_PREBUILT_BASE}/include/webp/decode.h")
    set(LIBWEBP_INCLUDE_DIR "${LIBWEBP_PREBUILT_BASE}/include")
elseif(EXISTS "${LIBWEBP_INCLUDE_CPP}/webp/decode.h")
    set(LIBWEBP_INCLUDE_DIR "${LIBWEBP_INCLUDE_CPP}")
elseif(EXISTS "${LIBWEBP_INCLUDE_CPP}/decode.h")
    set(LIBWEBP_INCLUDE_DIR "${LIBWEBP_INCLUDE_CPP}")
endif()
if(USE_LIBWEBP_PREBUILT AND LIBWEBP_INCLUDE_DIR)
    message(STATUS "libwebp: using prebuilt (libs: ${LIBWEBP_LIB_DIR}, include: ${LIBWEBP_INCLUDE_DIR})")
else()
    message(WARNING "libwebp prebuilt not found for ${ANDROID_ABI}. "
                    "sherpaOnnxEnableLibwebp=true requires prebuilts "
                    "(third_party/libwebp_prebuilt or Maven/GitHub).")
endif()
endif(USE_LIBWEBP)

if(USE_PDFIUM)
# PDFium: prebuilt only (third_party/pdfium_prebuilt or jniLibs + cpp/include/pdfium).
set(PDFIUM_PREBUILT_BASE "${PROJECT_ROOT}/../third_party/pdfium_prebuilt/android")
set(PDFIUM_PREBUILT_LIB "${PDFIUM_PREBUILT_BASE}/${ANDROID_ABI}/lib")
set(PDFIUM_PREBUILT_JNI_ABI "${PDFIUM_PREBUILT_BASE}/jni/${ANDROID_ABI}")
set(PDFIUM_JNILIBS "${PROJECT_ROOT}/src/main/jniLibs/${ANDROID_ABI}")
set(PDFIUM_INCLUDE_CPP "${PROJECT_ROOT}/src/main/cpp/include/pdfium")
set(USE_PDFIUM_PREBUILT OFF)
if(EXISTS "${PDFIUM_PREBUILT_LIB}/libpdfium.so")
    set(USE_PDFIUM_PREBUILT ON)
    set(PDFIUM_LIB_DIR "${PDFIUM_PREBUILT_LIB}")
elseif(EXISTS "${PDFIUM_PREBUILT_JNI_ABI}/libpdfium.so")
    set(USE_PDFIUM_PREBUILT ON)
    set(PDFIUM_LIB_DIR "${PDFIUM_PREBUILT_JNI_ABI}")
elseif(EXISTS "${PDFIUM_JNILIBS}/libpdfium.so")
    set(USE_PDFIUM_PREBUILT ON)
    set(PDFIUM_LIB_DIR "${PDFIUM_JNILIBS}")
endif()
if(EXISTS "${PDFIUM_PREBUILT_BASE}/include/fpdfview.h")
    set(PDFIUM_INCLUDE_DIR "${PDFIUM_PREBUILT_BASE}/include")
elseif(EXISTS "${PDFIUM_INCLUDE_CPP}/fpdfview.h")
    set(PDFIUM_INCLUDE_DIR "${PDFIUM_INCLUDE_CPP}")
endif()
if(USE_PDFIUM_PREBUILT AND PDFIUM_INCLUDE_DIR)
    message(STATUS "pdfium: using prebuilt (libs: ${PDFIUM_LIB_DIR}, include: ${PDFIUM_INCLUDE_DIR})")
else()
    message(WARNING "pdfium prebuilt not found for ${ANDROID_ABI}. "
                    "Run third_party/pdfium_prebuilt/fetch_pdfium_android.sh or CI workflow, "
                    "or unset sherpaOnnxEnablePdfium.")
endif()
endif(USE_PDFIUM)

# Create shared library
add_library(sherpaonnx SHARED
    ${SOURCES}
)

# sherpa-onnx C-API: link by directory + library name only (no IMPORTED target).
# The .so and headers land in jniLibs and cpp/include/sherpa-onnx via:
#   (1) local third_party build, (2) Maven AAR extraction (libs + c-api headers), or (3) GitHub release zip (last resort).
# If we used IMPORTED here, AGP would also copy .so from CMake --> duplicate in mergeNativeLibs.
set(SHERPA_ONNX_PREBUILT_BASE "${PROJECT_ROOT}/../third_party/sherpa-onnx-prebuilt/android")
set(SHERPA_ONNX_ABI_LIB "${SHERPA_ONNX_PREBUILT_BASE}/${ANDROID_ABI}/lib")
set(SHERPA_ONNX_JNI_ABI "${SHERPA_ONNX_PREBUILT_BASE}/jni/${ANDROID_ABI}")
set(SHERPA_C_API_LIB_DIR "")
if(EXISTS "${SHERPA_ONNX_ABI_LIB}/libsherpa-onnx-c-api.so")
    set(SHERPA_C_API_LIB_DIR "${SHERPA_ONNX_ABI_LIB}")
    message(STATUS "sherpa-onnx C-API (link only): ${SHERPA_C_API_LIB_DIR}")
elseif(EXISTS "${SHERPA_ONNX_JNI_ABI}/libsherpa-onnx-c-api.so")
    set(SHERPA_C_API_LIB_DIR "${SHERPA_ONNX_JNI_ABI}")
    message(STATUS "sherpa-onnx C-API (link only, third_party jni/<abi>): ${SHERPA_C_API_LIB_DIR}")
elseif(EXISTS "${PROJECT_ROOT}/src/main/jniLibs/${ANDROID_ABI}/libsherpa-onnx-c-api.so")
    set(SHERPA_C_API_LIB_DIR "${PROJECT_ROOT}/src/main/jniLibs/${ANDROID_ABI}")
    message(STATUS "sherpa-onnx C-API (link only, jniLibs): ${SHERPA_C_API_LIB_DIR}")
else()
    message(WARNING "sherpa-onnx C-API not found. Prebuilt sherpa native libs may be incomplete. "
                    "Build prebuilts: cd third_party/sherpa-onnx-prebuilt && ./build_sherpa_onnx.sh")
endif()

# ONNX Runtime C API headers for CTC alignment (same layout: <root>/onnxruntime/core/session/onnxruntime_c_api.h):
# (1) Monorepo third_party/onnxruntime/include (local dev / full ORT checkout)
# (2) android/src/main/cpp/include after Gradle copies headers/ or include/ from the onnxruntime AAR or third_party bundle
set(ORT_INCLUDE_MONO "${PROJECT_ROOT}/../third_party/onnxruntime/include")
set(ORT_INCLUDE_CPP "${PROJECT_ROOT}/src/main/cpp/include")
if(EXISTS "${ORT_INCLUDE_MONO}/onnxruntime/core/session/onnxruntime_c_api.h")
    set(ORT_INCLUDE_DIR "${ORT_INCLUDE_MONO}")
    message(STATUS "ONNX Runtime C API headers (CTC alignment, monorepo): ${ORT_INCLUDE_DIR}")
elseif(EXISTS "${ORT_INCLUDE_CPP}/onnxruntime/core/session/onnxruntime_c_api.h")
    set(ORT_INCLUDE_DIR "${ORT_INCLUDE_CPP}")
    message(STATUS "ONNX Runtime C API headers (CTC alignment, AAR/cpp/include): ${ORT_INCLUDE_DIR}")
else()
    message(FATAL_ERROR "ONNX Runtime C API headers not found. Expected onnxruntime/core/session/onnxruntime_c_api.h under:\n"
                        "  - ${ORT_INCLUDE_MONO} (third_party/onnxruntime submodule), or\n"
                        "  - ${ORT_INCLUDE_CPP} (run Android Gradle so prebuilt-download copies headers from onnxruntime AAR).")
endif()

set(ORT_JNILIB_DIR "${PROJECT_ROOT}/src/main/jniLibs/${ANDROID_ABI}")
if(EXISTS "${ORT_JNILIB_DIR}/libonnxruntime.so")
    message(STATUS "Linking libonnxruntime for CTC alignment: ${ORT_JNILIB_DIR}")
else()
    message(FATAL_ERROR "libonnxruntime.so not found for ${ANDROID_ABI} at ${ORT_JNILIB_DIR}. "
                        "Gradle should populate jniLibs from the onnxruntime bundle.")
endif()

target_include_directories(sherpaonnx PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/alignment
    ${CMAKE_CURRENT_SOURCE_DIR}/separation
    ${CMAKE_CURRENT_SOURCE_DIR}/diarization
    ${CMAKE_CURRENT_SOURCE_DIR}/speaker-embedding
    ${ORT_INCLUDE_DIR}
    # Flat ORT C++ API includes (onnxruntime_cxx_api.h) used by diarization + ort_guard_utils
    ${ORT_INCLUDE_DIR}/onnxruntime/core/session
    ${CMAKE_CURRENT_SOURCE_DIR}/jni
    ${CMAKE_CURRENT_SOURCE_DIR}/jni/module
    ${CMAKE_CURRENT_SOURCE_DIR}/jni/archive
    ${CMAKE_CURRENT_SOURCE_DIR}/jni/model_detect/common
    ${CMAKE_CURRENT_SOURCE_DIR}/jni/model_detect/stt
    ${CMAKE_CURRENT_SOURCE_DIR}/jni/model_detect/tts
    ${CMAKE_CURRENT_SOURCE_DIR}/jni/model_detect/enhancement
    ${CMAKE_CURRENT_SOURCE_DIR}/jni/model_detect/separation
    ${CMAKE_CURRENT_SOURCE_DIR}/jni/model_detect/speaker
    ${CMAKE_CURRENT_SOURCE_DIR}/jni/model_detect/diarization
    ${CMAKE_CURRENT_SOURCE_DIR}/jni/model_detect/punctuation
    ${CMAKE_CURRENT_SOURCE_DIR}/jni/model_detect/vad
    ${CMAKE_CURRENT_SOURCE_DIR}/jni/model_detect/alignment
    ${CMAKE_CURRENT_SOURCE_DIR}/jni/model_detect/ocr
    ${CMAKE_CURRENT_SOURCE_DIR}/jni/model_detect/slid
    ${CMAKE_CURRENT_SOURCE_DIR}/jni/model_detect/kws
    ${CMAKE_CURRENT_SOURCE_DIR}/jni/model_detect/audio_tagging
    ${CMAKE_CURRENT_SOURCE_DIR}/jni/audio
    ${CMAKE_CURRENT_SOURCE_DIR}/image
    ${CMAKE_CURRENT_SOURCE_DIR}/image/decode
    ${CMAKE_CURRENT_SOURCE_DIR}/video
    ${LIBYUV_INCLUDE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/ocr
    ${CMAKE_CURRENT_SOURCE_DIR}/ocr/ppocr
    ${CMAKE_CURRENT_SOURCE_DIR}/ocr/doctr
    ${CMAKE_CURRENT_SOURCE_DIR}/ocr/doc_vlm
    ${CMAKE_CURRENT_SOURCE_DIR}/ocr/nemotron_parse
    ${CMAKE_CURRENT_SOURCE_DIR}/ocr/paddleocr_vl
    ${CMAKE_CURRENT_SOURCE_DIR}/pdf
    ${CMAKE_CURRENT_SOURCE_DIR}/document
    ${PROJECT_ROOT}/../third_party/pugixml/src
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)
if(USE_FFMPEG)
    target_include_directories(sherpaonnx PRIVATE ${FFMPEG_INCLUDE_DIR})
endif()
if(USE_LIBARCHIVE AND USE_LIBARCHIVE_PREBUILT AND LIBARCHIVE_INCLUDE_DIR)
    target_include_directories(sherpaonnx PRIVATE ${LIBARCHIVE_INCLUDE_DIR})
endif()
if(USE_LIBWEBP AND LIBWEBP_INCLUDE_DIR)
    target_include_directories(sherpaonnx PRIVATE ${LIBWEBP_INCLUDE_DIR})
endif()
if(USE_PDFIUM AND PDFIUM_INCLUDE_DIR)
    target_include_directories(sherpaonnx PRIVATE ${PDFIUM_INCLUDE_DIR})
endif()
if(LEXBOR_INCLUDE_DIR)
    target_include_directories(sherpaonnx PRIVATE ${LEXBOR_INCLUDE_DIR})
endif()
# When USE_FFMPEG=OFF, do NOT define HAVE_FFMPEG at all. Then #ifdef HAVE_FFMPEG is false
# in C++ and the stub (#else) branches are used — no FFmpeg headers needed.
if(USE_FFMPEG)
    target_compile_definitions(sherpaonnx PRIVATE HAVE_FFMPEG=1)
endif()
# When USE_LIBARCHIVE=OFF, do NOT define HAVE_LIBARCHIVE; extractTarBz2 stubs return an error.
if(USE_LIBARCHIVE)
    target_compile_definitions(sherpaonnx PRIVATE HAVE_LIBARCHIVE=1)
endif()
if(USE_LIBWEBP)
    target_compile_definitions(sherpaonnx PRIVATE HAVE_LIBWEBP=1)
endif()
if(USE_PDFIUM AND USE_PDFIUM_PREBUILT AND PDFIUM_INCLUDE_DIR)
    target_compile_definitions(sherpaonnx PRIVATE HAVE_PDFIUM=1)
endif()

# Link libraries (Kotlin API from AAR handles STT/TTS incl. Zipvoice)
if(USE_FFMPEG)
    target_link_directories(sherpaonnx PRIVATE ${FFMPEG_LIB_DIR})
endif()
if(USE_LIBARCHIVE AND USE_LIBARCHIVE_PREBUILT AND LIBARCHIVE_LIB_DIR)
    target_link_directories(sherpaonnx PRIVATE ${LIBARCHIVE_LIB_DIR})
endif()
if(USE_LIBWEBP AND USE_LIBWEBP_PREBUILT AND LIBWEBP_LIB_DIR)
    target_link_directories(sherpaonnx PRIVATE ${LIBWEBP_LIB_DIR})
endif()
if(USE_PDFIUM AND USE_PDFIUM_PREBUILT AND PDFIUM_LIB_DIR)
    target_link_directories(sherpaonnx PRIVATE ${PDFIUM_LIB_DIR})
endif()
if(USE_LEXBOR_PREBUILT AND LEXBOR_LIB_DIR)
    target_link_directories(sherpaonnx PRIVATE ${LEXBOR_LIB_DIR})
endif()
if(USE_LIBYUV_PREBUILT AND LIBYUV_LIB_DIR)
    target_link_directories(sherpaonnx PRIVATE ${LIBYUV_LIB_DIR})
endif()
if(SHERPA_C_API_LIB_DIR)
    target_link_directories(sherpaonnx PRIVATE ${SHERPA_C_API_LIB_DIR})
    target_link_libraries(sherpaonnx PRIVATE sherpa-onnx-c-api)
endif()
target_link_directories(sherpaonnx PRIVATE ${ORT_JNILIB_DIR})
target_link_libraries(sherpaonnx PRIVATE onnxruntime)
if(TARGET ReactAndroid::jsi)
    target_link_libraries(sherpaonnx PRIVATE ReactAndroid::jsi)
elseif(TARGET jsi)
    target_link_libraries(sherpaonnx PRIVATE jsi)
else()
    message(WARNING "JSI target not found (ReactAndroid::jsi/jsi). Building without explicit JSI linkage.")
endif()
# Link archive only when USE_LIBARCHIVE (otherwise libsherpaonnx.so would depend on libarchive.so at load time).
if(USE_FFMPEG)
    target_link_libraries(sherpaonnx
        PRIVATE
        avcodec
        avformat
        avutil
        avfilter
        swresample
    )
endif()
if(USE_LIBARCHIVE)
    target_link_libraries(sherpaonnx PRIVATE archive)
endif()
if(USE_LIBWEBP AND USE_LIBWEBP_PREBUILT)
    target_link_libraries(sherpaonnx PRIVATE webp sharpyuv)
endif()
if(USE_PDFIUM AND USE_PDFIUM_PREBUILT AND PDFIUM_LIB_DIR)
    target_link_libraries(sherpaonnx PRIVATE pdfium)
endif()
target_link_libraries(sherpaonnx PRIVATE log android jnigraphics lexbor yuv mediandk)

# Compiler flags for our library
target_compile_options(sherpaonnx PRIVATE
    -Wall
    -Wextra
    -fvisibility=hidden
    -g
)

# Android 15+ requires 16 KB page-size compatibility on arm64 devices.
# Keep this target aligned with the other bundled sherpa shared libraries.
# https://github.com/XDcobra/react-native-sherpa-onnx/issues/76
if(ANDROID)
    target_link_options(sherpaonnx PRIVATE "-Wl,-z,max-page-size=16384")
    # NDK clang already static-links libunwind into a SHARED+exceptions DSO, but
    # -lpdfium exports _Unwind_Resume so ld binds our EH relocs there instead
    # (C++ throw → SIGBUS). Force the compiler's libunwind.a into this DSO and
    # keep it non-exported. NDK 29 clang++ has no -static-libunwind.
    execute_process(
        COMMAND "${CMAKE_CXX_COMPILER}" "--target=${CMAKE_CXX_COMPILER_TARGET}"
                "-print-file-name=libunwind.a"
        OUTPUT_VARIABLE _SHERPA_UNWIND_A
        OUTPUT_STRIP_TRAILING_WHITESPACE
        RESULT_VARIABLE _SHERPA_UNWIND_RC
    )
    if(NOT _SHERPA_UNWIND_RC EQUAL 0 OR NOT EXISTS "${_SHERPA_UNWIND_A}")
        message(FATAL_ERROR
            "libunwind.a not found via ${CMAKE_CXX_COMPILER} -print-file-name "
            "(rc=${_SHERPA_UNWIND_RC}, path='${_SHERPA_UNWIND_A}'). "
            "Required so C++ exceptions do not bind to libpdfium.so.")
    endif()
    target_link_libraries(sherpaonnx PRIVATE
        "-Wl,--whole-archive" "${_SHERPA_UNWIND_A}" "-Wl,--no-whole-archive"
        "-Wl,--exclude-libs,libunwind.a")
    message(STATUS "sherpaonnx: static libunwind (${_SHERPA_UNWIND_A})")
endif()
