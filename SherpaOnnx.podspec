require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))
pod_root = __dir__

# Run iOS framework setup when podspec is loaded (works for :path pods).
setup_script = File.join(pod_root, "scripts", "setup-ios-framework.sh")
if File.exist?(setup_script)
  prev = ENV["SHERPA_ONNX_PROJECT_ROOT"]
  ENV["SHERPA_ONNX_PROJECT_ROOT"] = pod_root
  unless system("bash", setup_script)
    ENV["SHERPA_ONNX_PROJECT_ROOT"] = prev
    abort("[SherpaOnnx] setup-ios-framework.sh failed. Check IOS_RELEASE_TAG files (sherpa-onnx-prebuilt, ffmpeg_prebuilt, libarchive_prebuilt, lexbor_prebuilt, libwebp_prebuilt) and network. Run manually: bash #{setup_script}")
  end
  ENV["SHERPA_ONNX_PROJECT_ROOT"] = prev
end

Pod::Spec.new do |s|
  s.name         = "SherpaOnnx"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]

  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/XDcobra/react-native-sherpa-onnx.git", :tag => "#{s.version}" }

  s.source_files = [
    "ios/**/*.{h,m,mm,swift,cpp}",
    # Shared with Android NDK: portable model_detect C++ (detection/validation/catalog).
    # Android-only JNI marshalling (*-wrapper.cpp, detect-jni-common.cpp) is excluded below — iOS uses ios/**/\*.mm bridges.
    "android/src/main/cpp/jni/model_detect/**/*.cpp",
    # Shared alignment core (segmenter + proportional/estimated/accurate CTC).
    "android/src/main/cpp/alignment/sherpa_onnx_ctc_alignment.cpp",
    "android/src/main/cpp/alignment/sherpa_onnx_alignment_engine.cpp",
    # Shared audio decode primitive (WAV fast path + FFmpeg). JNI bridge excluded below.
    "android/src/main/cpp/jni/audio/AudioDecodeSession.cpp",
    "android/src/main/cpp/jni/audio/AudioDecodeSession.h",
    "android/src/main/cpp/jni/audio/AudioVisualization.cpp",
    "android/src/main/cpp/jni/audio/AudioVisualization.h",
    "android/src/main/cpp/jni/audio/FfmpegFormatGuard.cpp",
    "android/src/main/cpp/jni/audio/FfmpegFormatGuard.h",
    # Shared audio encode primitive (WAV fast path + FFmpeg). JNI bridge excluded below.
    "android/src/main/cpp/jni/audio/AudioEncodeSession.cpp",
    "android/src/main/cpp/jni/audio/AudioEncodeSession.h",
    # Native crash diagnostics (shared ring buffer + iOS signal handler).
    "android/src/main/cpp/jni/diagnostic/NativeDiagnostic.cpp",
    "android/src/main/cpp/jni/diagnostic/NativeDiagnostic.h",
    "android/src/main/cpp/jni/diagnostic/NativeDiagnosticIOS.mm",
    # Shared separation inference core. JNI bridge excluded below.
    "android/src/main/cpp/separation/sherpa-onnx-separation-wrapper.cpp",
    "android/src/main/cpp/separation/sherpa-onnx-separation-wrapper.h",
    # Shared diarization core (decomposed pyannote + clustering; embedding via speaker-embedding/).
    "android/src/main/cpp/diarization/*.cpp",
    "android/src/main/cpp/diarization/*.h",
    # Shared speaker-embedding core (C-API runner + manager + SID facade).
    "android/src/main/cpp/speaker-embedding/*.cpp",
    "android/src/main/cpp/speaker-embedding/*.h",
    # Shared ImageBuffer core (decode + registry; JNI excluded below).
    "android/src/main/cpp/image/**/*.{h,cpp}",
    # Shared OCR core (factory + PpocrBackend + OcrEngine; JNI excluded below).
    "android/src/main/cpp/ocr/**/*.{h,cpp}",
    # Shared ORT provider attach (sherpa-style CPU fallback).
    "android/src/main/cpp/ort/**/*.{h,cpp}",
    # Shared PDF text-layer core (JNI excluded below).
    "android/src/main/cpp/pdf/**/*.{h,cpp}",
    # Shared e-document extractor (EPUB/FB2/CBZ/CBR). JNI excluded below.
    "android/src/main/cpp/document/*.{h,hpp,cpp}",
    # Shared seekable FileSource (document/ + pdf/).
    "android/src/main/cpp/fileio/**/*.{h,hpp}",
    "third_party/pugixml/src/pugixml.cpp",
    "third_party/pugixml/src/*.hpp",
  ]
  # Exclude vendored framework headers from the compile/copy phases to avoid
  # duplicate PrivateHeaders outputs when CocoaPods builds this pod as framework.
  s.exclude_files = [
    "ios/Frameworks/**/*",
    # Duplicate implementations: use android/src/main/cpp/jni/model_detect sources only.
    "ios/model_detect/**/*",
    # Android JNI only (jni.h / JNIEnv). iOS compiles ObjC++ wrappers under ios/ instead.
    "android/src/main/cpp/jni/model_detect/**/sherpa-onnx-*-wrapper.cpp",
    "android/src/main/cpp/jni/model_detect/common/sherpa-onnx-unified-detect-wrapper.cpp",
    "android/src/main/cpp/jni/model_detect/common/sherpa-onnx-detect-jni-common.cpp",
    "android/src/main/cpp/jni/audio/audio_decode_jni.cpp",
    "android/src/main/cpp/jni/audio/audio_encode_jni.cpp",
    "android/src/main/cpp/jni/diagnostic/NativeDiagnosticAndroid.cpp",
    "android/src/main/cpp/jni/diagnostic/native_diagnostic_jni.cpp",
    "android/src/main/cpp/jni/separation/sherpa-onnx-separation-jni.cpp",
    "android/src/main/cpp/jni/diarization/sherpa-onnx-diarization-jni.cpp",
    "android/src/main/cpp/jni/speaker-embedding/sherpa-onnx-speaker-embedding-jni.cpp",
    "android/src/main/cpp/jni/image/**/*",
    "android/src/main/cpp/jni/ocr/**/*",
    "android/src/main/cpp/jni/pdf/**/*",
    "android/src/main/cpp/jni/document/**/*",
    # stb is included from ImageDecoder.cpp; do not compile as a separate TU.
    "android/src/main/cpp/image/decode/vendor/**/*"
  ]
  private_headers = Dir.glob(File.join(pod_root, "ios", "**", "*.h")).reject do |path|
    path.start_with?(File.join(pod_root, "ios", "Frameworks") + File::SEPARATOR)
  end
  # Mark all shared C++ headers from android/ as private so CocoaPods does not
  # put them in the umbrella module map. Swift's Clang dependency scanner builds
  # the module as non-C++ and fails on #include <cstdint> otherwise.
  private_headers += Dir.glob(File.join(pod_root, "android", "src", "main", "cpp", "**", "*.h"))
  s.private_header_files = private_headers.map { |path| path.sub("#{pod_root}/", "") }

  s.frameworks = "Foundation", "Accelerate", "CoreML", "AVFoundation", "AudioToolbox", "ImageIO", "CoreGraphics", "UIKit"

  ffmpeg_xcframework = File.join(pod_root, "ios", "Frameworks", "FFmpeg.xcframework")
  libarchive_xcframework = File.join(pod_root, "ios", "Frameworks", "libarchive.xcframework")
  lexbor_xcframework = File.join(pod_root, "ios", "Frameworks", "lexbor.xcframework")
  libwebp_xcframework = File.join(pod_root, "ios", "Frameworks", "libwebp.xcframework")
  pdfium_xcframework = File.join(pod_root, "ios", "Frameworks", "pdfium.xcframework")

  has_ffmpeg = false
  disable_ffmpeg = ENV['SHERPA_ONNX_DISABLE_FFMPEG']
  if (!disable_ffmpeg || disable_ffmpeg == '0' || disable_ffmpeg == 'false') && File.exist?(ffmpeg_xcframework)
    has_ffmpeg = true
  end

  has_libarchive = false
  disable_libarchive = ENV['SHERPA_ONNX_DISABLE_LIBARCHIVE']
  if (!disable_libarchive || disable_libarchive == '0' || disable_libarchive == 'false') && File.exist?(libarchive_xcframework)
    has_libarchive = true
  end

  has_lexbor = File.exist?(lexbor_xcframework)

  # Opt-in (default off). Require explicit SHERPA_ONNX_ENABLE_LIBWEBP=1 and xcframework present.
  has_libwebp = false
  enable_libwebp = ENV['SHERPA_ONNX_ENABLE_LIBWEBP']
  if (enable_libwebp == '1' || enable_libwebp == 'true') && File.exist?(libwebp_xcframework)
    has_libwebp = true
  end

  # Opt-in (default off). Require explicit SHERPA_ONNX_ENABLE_PDFIUM=1 and xcframework present.
  has_pdfium = false
  enable_pdfium = ENV['SHERPA_ONNX_ENABLE_PDFIUM']
  if (enable_pdfium == '1' || enable_pdfium == 'true') && File.exist?(pdfium_xcframework)
    has_pdfium = true
  end

  vendored = ["ios/Frameworks/sherpa_onnx.xcframework"]
  vendored << "ios/Frameworks/FFmpeg.xcframework" if has_ffmpeg
  vendored << "ios/Frameworks/libarchive.xcframework" if has_libarchive
  vendored << "ios/Frameworks/lexbor.xcframework" if has_lexbor
  vendored << "ios/Frameworks/libwebp.xcframework" if has_libwebp
  vendored << "ios/Frameworks/pdfium.xcframework" if has_pdfium
  
  s.vendored_frameworks = vendored
  # Absolute paths so headers are found regardless of PODS_TARGET_SRCROOT (e.g. when building via React Native CLI).
  xcframework_root = File.join(pod_root, "ios", "Frameworks", "sherpa_onnx.xcframework")
  simulator_headers = File.join(xcframework_root, "ios-arm64_x86_64-simulator", "SherpaOnnxC.framework", "Headers")
  device_headers = File.join(xcframework_root, "ios-arm64", "SherpaOnnxC.framework", "Headers")
  simulator_slice = File.join(xcframework_root, "ios-arm64_x86_64-simulator")
  device_slice = File.join(xcframework_root, "ios-arm64")
  device_sherpa_binary = File.join(device_slice, "SherpaOnnxC.framework", "SherpaOnnxC")
  simulator_sherpa_binary = File.join(simulator_slice, "SherpaOnnxC.framework", "SherpaOnnxC")

  libarchive_xcframework_root = File.join(pod_root, "ios", "Frameworks", "libarchive.xcframework")
  libarchive_simulator_headers = File.join(libarchive_xcframework_root, "ios-arm64_x86_64-simulator", "Headers")
  libarchive_device_headers = File.join(libarchive_xcframework_root, "ios-arm64", "Headers")
  libarchive_simulator_slice = File.join(libarchive_xcframework_root, "ios-arm64_x86_64-simulator")
  libarchive_device_slice = File.join(libarchive_xcframework_root, "ios-arm64")

  lexbor_xcframework_root = File.join(pod_root, "ios", "Frameworks", "lexbor.xcframework")
  lexbor_simulator_headers = File.join(lexbor_xcframework_root, "ios-arm64_x86_64-simulator", "Headers")
  lexbor_device_headers = File.join(lexbor_xcframework_root, "ios-arm64", "Headers")
  lexbor_simulator_slice = File.join(lexbor_xcframework_root, "ios-arm64_x86_64-simulator")
  lexbor_device_slice = File.join(lexbor_xcframework_root, "ios-arm64")

  libwebp_xcframework_root = File.join(pod_root, "ios", "Frameworks", "libwebp.xcframework")
  libwebp_simulator_headers = File.join(libwebp_xcframework_root, "ios-arm64_x86_64-simulator", "Headers")
  libwebp_device_headers = File.join(libwebp_xcframework_root, "ios-arm64", "Headers")
  libwebp_simulator_slice = File.join(libwebp_xcframework_root, "ios-arm64_x86_64-simulator")
  libwebp_device_slice = File.join(libwebp_xcframework_root, "ios-arm64")

  pdfium_xcframework_root = File.join(pod_root, "ios", "Frameworks", "pdfium.xcframework")
  pdfium_simulator_headers = File.join(pdfium_xcframework_root, "ios-arm64_x86_64-simulator", "Headers")
  pdfium_device_headers = File.join(pdfium_xcframework_root, "ios-arm64", "Headers")
  pdfium_simulator_slice = File.join(pdfium_xcframework_root, "ios-arm64_x86_64-simulator")
  pdfium_device_slice = File.join(pdfium_xcframework_root, "ios-arm64")

  ffmpeg_simulator_headers = File.join(ffmpeg_xcframework, "ios-arm64_x86_64-simulator", "Headers")
  ffmpeg_device_headers = File.join(ffmpeg_xcframework, "ios-arm64", "Headers")
  ffmpeg_simulator_slice = File.join(ffmpeg_xcframework, "ios-arm64_x86_64-simulator")
  ffmpeg_device_slice = File.join(ffmpeg_xcframework, "ios-arm64")

  gcc_defs = '$(inherited) PLATFORM_CONFIG_H=\\"libarchive_darwin_config.h\\"'
  gcc_defs += ' LEXBOR_STATIC=1' if has_lexbor
  gcc_defs += ' HAVE_FFMPEG=1' if has_ffmpeg
  gcc_defs += ' HAVE_LIBARCHIVE=1' if has_libarchive
  gcc_defs += ' HAVE_LIBWEBP=1' if has_libwebp
  gcc_defs += ' HAVE_PDFIUM=1' if has_pdfium

  ld_flags_base = '$(inherited)'
  if has_ffmpeg
    ld_flags_base += ' -lffmpeg -liconv -lbz2'
  end
  if has_libarchive
    ld_flags_base += ' -larchive'
  end
  if has_lexbor
    ld_flags_base += ' -llexbor'
  end
  if has_libwebp
    ld_flags_base += ' -lwebp'
  end
  if has_pdfium
    ld_flags_base += ' -lpdfium'
  end
  ld_flags_ios = "#{ld_flags_base} -force_load \"#{device_sherpa_binary}\""
  ld_flags_sim = "#{ld_flags_base} -force_load \"#{simulator_sherpa_binary}\""

  header_search_paths = [
    "$(inherited)",
    "\"#{pod_root}/ios/stt/native\"",
    "\"#{pod_root}/android/src/main/cpp/jni/model_detect/common\"",
    "\"#{pod_root}/android/src/main/cpp/jni/model_detect/stt\"",
    "\"#{pod_root}/android/src/main/cpp/jni/model_detect/tts\"",
    "\"#{pod_root}/android/src/main/cpp/jni/model_detect/enhancement\"",
    "\"#{pod_root}/android/src/main/cpp/jni/model_detect/separation\"",
    "\"#{pod_root}/android/src/main/cpp/jni/model_detect/speaker\"",
    "\"#{pod_root}/android/src/main/cpp/jni/model_detect/diarization\"",
    "\"#{pod_root}/android/src/main/cpp/separation\"",
    "\"#{pod_root}/android/src/main/cpp/diarization\"",
    "\"#{pod_root}/android/src/main/cpp/speaker-embedding\"",
    "\"#{pod_root}/third_party/onnxruntime/include/onnxruntime/core/session\"",
    "\"#{pod_root}/android/src/main/cpp/jni/model_detect/punctuation\"",
    "\"#{pod_root}/android/src/main/cpp/jni/model_detect/vad\"",
    "\"#{pod_root}/android/src/main/cpp/jni/model_detect/alignment\"",
    "\"#{pod_root}/android/src/main/cpp/jni/model_detect/ocr\"",
    "\"#{pod_root}/android/src/main/cpp/jni/model_detect/kws\"",
    "\"#{pod_root}/android/src/main/cpp/jni/model_detect/slid\"",
    "\"#{pod_root}/android/src/main/cpp/jni/model_detect/audio_tagging\"",
    "\"#{pod_root}/android/src/main/cpp/alignment\"",
    "\"#{pod_root}/android/src/main/cpp/jni/audio\"",
    "\"#{pod_root}/android/src/main/cpp/image\"",
    "\"#{pod_root}/android/src/main/cpp/image/decode\"",
    "\"#{pod_root}/android/src/main/cpp/ocr\"",
    "\"#{pod_root}/android/src/main/cpp/ocr/ppocr\"",
    "\"#{pod_root}/android/src/main/cpp/ocr/doctr\"",
    "\"#{pod_root}/android/src/main/cpp/ocr/doc_vlm\"",
    "\"#{pod_root}/android/src/main/cpp/ocr/nemotron_parse\"",
    "\"#{pod_root}/android/src/main/cpp\"",
    "\"#{pod_root}/android/src/main/cpp/pdf\"",
    "\"#{pod_root}/android/src/main/cpp/document\"",
    "\"#{pod_root}/third_party/pugixml/src\"",
    "\"#{pod_root}/third_party/onnxruntime/include\"",
    "\"#{pod_root}/ios/ocr\"",
    "\"#{pod_root}/ios/ocr/bridge\"",
    "\"#{pod_root}/ios/pdf\"",
    "\"#{pod_root}/ios/pdf/bridge\"",
    "\"#{pod_root}/ios\"",
    "\"#{pod_root}/ios/archive\"",
    "\"#{pod_root}/ios/stt\"",
    "\"#{pod_root}/ios/tts\"",
    "\"#{pod_root}/ios/enhancement\"",
    "\"#{pod_root}/ios/separation\"",
    "\"#{pod_root}/ios/speaker-embedding\"",
    "\"#{pod_root}/ios/diarization\"",
    "\"#{pod_root}/ios/punctuation\"",
    "\"#{pod_root}/ios/slid\"",
    "\"#{pod_root}/ios/slid/core\"",
    "\"#{pod_root}/ios/slid/bridge\"",
    "\"#{pod_root}/ios/slid/pipeline\"",
    "\"#{pod_root}/ios/kws\"",
    "\"#{pod_root}/ios/kws/bridge\"",
    "\"#{pod_root}/ios/kws/native\"",
    "\"#{pod_root}/ios/kws/pipeline\"",
    "\"#{pod_root}/ios/audio-tagging\"",
    "\"#{pod_root}/ios/audio-tagging/bridge\"",
    "\"#{pod_root}/ios/audio-tagging/core\"",
    "\"#{pod_root}/ios/audio-tagging/pipeline\"",
    "\"#{device_headers}\"",
    "\"#{simulator_headers}\""
  ]
  if has_libarchive
    header_search_paths << "\"#{libarchive_device_headers}\""
    header_search_paths << "\"#{libarchive_simulator_headers}\""
  end
  if has_lexbor
    header_search_paths << "\"#{lexbor_device_headers}\""
    header_search_paths << "\"#{lexbor_simulator_headers}\""
  end
  if has_libwebp
    header_search_paths << "\"#{libwebp_device_headers}\""
    header_search_paths << "\"#{libwebp_simulator_headers}\""
  end
  if has_pdfium
    header_search_paths << "\"#{pdfium_device_headers}\""
    header_search_paths << "\"#{pdfium_simulator_headers}\""
  end
  if has_ffmpeg
    header_search_paths << "\"#{ffmpeg_device_headers}\""
    header_search_paths << "\"#{ffmpeg_simulator_headers}\""
  end

  library_search_paths_ios = ["$(inherited)", "\"#{device_slice}\""]
  library_search_paths_sim = ["$(inherited)", "\"#{simulator_slice}\""]
  if has_ffmpeg
    library_search_paths_ios << "\"#{ffmpeg_device_slice}\""
    library_search_paths_sim << "\"#{ffmpeg_simulator_slice}\""
  end
  if has_libarchive
    library_search_paths_ios << "\"#{libarchive_device_slice}\""
    library_search_paths_sim << "\"#{libarchive_simulator_slice}\""
  end
  if has_lexbor
    library_search_paths_ios << "\"#{lexbor_device_slice}\""
    library_search_paths_sim << "\"#{lexbor_simulator_slice}\""
  end
  if has_libwebp
    library_search_paths_ios << "\"#{libwebp_device_slice}\""
    library_search_paths_sim << "\"#{libwebp_simulator_slice}\""
  end
  if has_pdfium
    library_search_paths_ios << "\"#{pdfium_device_slice}\""
    library_search_paths_sim << "\"#{pdfium_simulator_slice}\""
  end

  s.pod_target_xcconfig = {
    "HEADER_SEARCH_PATHS" => header_search_paths.join(" "),
    "GCC_PREPROCESSOR_DEFINITIONS" => gcc_defs,
    "CLANG_CXX_LANGUAGE_STANDARD" => "c++17",
    "CLANG_CXX_LIBRARY" => "libc++",
    "OTHER_CPLUSPLUSFLAGS" => "$(inherited)",
    "LIBRARY_SEARCH_PATHS[sdk=iphoneos*]" => library_search_paths_ios.join(" "),
    "LIBRARY_SEARCH_PATHS[sdk=iphonesimulator*]" => library_search_paths_sim.join(" "),
    "OTHER_LDFLAGS[sdk=iphoneos*]" => ld_flags_ios,
    "OTHER_LDFLAGS[sdk=iphonesimulator*]" => ld_flags_sim
  }

  s.user_target_xcconfig = {
    "CLANG_CXX_LANGUAGE_STANDARD" => "c++17",
    "CLANG_CXX_LIBRARY" => "libc++",
    "LIBRARY_SEARCH_PATHS[sdk=iphoneos*]" => library_search_paths_ios.join(" "),
    "LIBRARY_SEARCH_PATHS[sdk=iphonesimulator*]" => library_search_paths_sim.join(" "),
    "OTHER_LDFLAGS[sdk=iphoneos*]" => ld_flags_ios,
    "OTHER_LDFLAGS[sdk=iphonesimulator*]" => ld_flags_sim
  }

  s.libraries = "c++", "z", "iconv", "bz2"

  # Per-release-model license metadata (synced from CI; same CSV as android/src/main/assets/model_licenses/).
  # Use resource_bundles so assets are packaged reliably across CocoaPods integration modes.
  s.resource_bundles = {
    "SherpaOnnxResources" => ["ios/Resources/model_licenses/*.csv"]
  }

  install_modules_dependencies(s)
end
