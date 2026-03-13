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
    abort("[SherpaOnnx] setup-ios-framework.sh failed. Check IOS_RELEASE_TAG files (sherpa-onnx-prebuilt, ffmpeg_prebuilt, libarchive_prebuilt) and network. Run manually: bash #{setup_script}")
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

  s.source_files = ["ios/**/*.{h,m,mm,swift,cpp}"]
  # Exclude vendored framework headers from the compile/copy phases to avoid
  # duplicate PrivateHeaders outputs when CocoaPods builds this pod as framework.
  s.exclude_files = ["ios/Frameworks/**/*"]
  private_headers = Dir.glob(File.join(pod_root, "ios", "**", "*.h")).reject do |path|
    path.start_with?(File.join(pod_root, "ios", "Frameworks") + File::SEPARATOR)
  end
  s.private_header_files = private_headers.map { |path| path.sub("#{pod_root}/", "") }

  s.frameworks = "Foundation", "Accelerate", "CoreML", "AVFoundation", "AudioToolbox"

  ffmpeg_xcframework = File.join(pod_root, "ios", "Frameworks", "FFmpeg.xcframework")
  libarchive_xcframework = File.join(pod_root, "ios", "Frameworks", "libarchive.xcframework")
  
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

  vendored = ["ios/Frameworks/sherpa_onnx.xcframework"]
  vendored << "ios/Frameworks/FFmpeg.xcframework" if has_ffmpeg
  vendored << "ios/Frameworks/libarchive.xcframework" if has_libarchive
  
  s.vendored_frameworks = vendored
  # Absolute paths so headers are found regardless of PODS_TARGET_SRCROOT (e.g. when building via React Native CLI).
  xcframework_root = File.join(pod_root, "ios", "Frameworks", "sherpa_onnx.xcframework")
  simulator_headers = File.join(xcframework_root, "ios-arm64_x86_64-simulator", "Headers")
  device_headers = File.join(xcframework_root, "ios-arm64", "Headers")
  simulator_slice = File.join(xcframework_root, "ios-arm64_x86_64-simulator")
  device_slice = File.join(xcframework_root, "ios-arm64")

  libarchive_xcframework_root = File.join(pod_root, "ios", "Frameworks", "libarchive.xcframework")
  libarchive_simulator_headers = File.join(libarchive_xcframework_root, "ios-arm64_x86_64-simulator", "Headers")
  libarchive_device_headers = File.join(libarchive_xcframework_root, "ios-arm64", "Headers")
  libarchive_simulator_slice = File.join(libarchive_xcframework_root, "ios-arm64_x86_64-simulator")
  libarchive_device_slice = File.join(libarchive_xcframework_root, "ios-arm64")

  ffmpeg_simulator_headers = File.join(ffmpeg_xcframework, "ios-arm64_x86_64-simulator", "Headers")
  ffmpeg_device_headers = File.join(ffmpeg_xcframework, "ios-arm64", "Headers")
  ffmpeg_simulator_slice = File.join(ffmpeg_xcframework, "ios-arm64_x86_64-simulator")
  ffmpeg_device_slice = File.join(ffmpeg_xcframework, "ios-arm64")

  gcc_defs = '$(inherited) PLATFORM_CONFIG_H=\\"libarchive_darwin_config.h\\"'
  gcc_defs += ' HAVE_FFMPEG=1' if has_ffmpeg
  gcc_defs += ' HAVE_LIBARCHIVE=1' if has_libarchive

  ld_flags = '$(inherited) -lsherpa-onnx'
  if has_ffmpeg
    ld_flags += ' -lffmpeg -liconv -lbz2'
  end
  if has_libarchive
    ld_flags += ' -larchive'
  end

  header_search_paths = [
    "$(inherited)",
    "\"#{pod_root}/ios\"",
    "\"#{pod_root}/ios/archive\"",
    "\"#{pod_root}/ios/model_detect\"",
    "\"#{pod_root}/ios/stt\"",
    "\"#{pod_root}/ios/tts\"",
    "\"#{pod_root}/ios/online_stt\"",
    "\"#{device_headers}\"",
    "\"#{simulator_headers}\""
  ]
  if has_libarchive
    header_search_paths << "\"#{libarchive_device_headers}\""
    header_search_paths << "\"#{libarchive_simulator_headers}\""
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

  s.pod_target_xcconfig = {
    "HEADER_SEARCH_PATHS" => header_search_paths.join(" "),
    "GCC_PREPROCESSOR_DEFINITIONS" => gcc_defs,
    "CLANG_CXX_LANGUAGE_STANDARD" => "c++17",
    "CLANG_CXX_LIBRARY" => "libc++",
    "OTHER_CPLUSPLUSFLAGS" => "$(inherited)",
    "LIBRARY_SEARCH_PATHS[sdk=iphoneos*]" => library_search_paths_ios.join(" "),
    "LIBRARY_SEARCH_PATHS[sdk=iphonesimulator*]" => library_search_paths_sim.join(" "),
    "OTHER_LDFLAGS" => ld_flags
  }

  s.user_target_xcconfig = {
    "CLANG_CXX_LANGUAGE_STANDARD" => "c++17",
    "CLANG_CXX_LIBRARY" => "libc++",
    "LIBRARY_SEARCH_PATHS[sdk=iphoneos*]" => library_search_paths_ios.join(" "),
    "LIBRARY_SEARCH_PATHS[sdk=iphonesimulator*]" => library_search_paths_sim.join(" "),
    "OTHER_LDFLAGS" => ld_flags
  }

  s.libraries = "c++", "z", "iconv", "bz2"

  install_modules_dependencies(s)
end
