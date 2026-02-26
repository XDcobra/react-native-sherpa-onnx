require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))
pod_root = __dir__
# Prefer libarchive_prebuilt layout (output of third_party/libarchive_prebuilt/build_libarchive_ios.sh).
# Fallback: download via setup-ios-libarchive.sh to ios/Downloads/libarchive (e.g. when using SDK from npm).
libarchive_prebuilt = File.join(pod_root, "third_party", "libarchive_prebuilt", "libarchive-ios-layout")
libarchive_downloads = File.join(pod_root, "ios", "Downloads", "libarchive")
unless File.directory?(libarchive_prebuilt) && Dir.glob(File.join(libarchive_prebuilt, "*.c")).any?
  libarchive_script = File.join(pod_root, "ios", "scripts", "setup-ios-libarchive.sh")
  if File.exist?(libarchive_script)
    unless system("bash", libarchive_script)
      abort("[SherpaOnnx] setup-ios-libarchive.sh failed. Check that third_party/libarchive_prebuilt/IOS_RELEASE_TAG exists and the release is available (network). Run the script manually: bash #{libarchive_script}")
    end
  end
end
libarchive_dir = (File.directory?(libarchive_prebuilt) && Dir.glob(File.join(libarchive_prebuilt, "*.c")).any?) ? libarchive_prebuilt : libarchive_downloads
# Patch libarchive .c files (copy to ios/patched_libarchive with stdio.h/unistd.h added) so we don't modify the submodule.
patched_dir = File.join(pod_root, "ios", "patched_libarchive")
patch_script = File.join(pod_root, "ios", "scripts", "patch-libarchive-includes.sh")
if File.directory?(libarchive_dir) && File.exist?(patch_script)
  unless system("bash", patch_script, libarchive_dir)
    abort("[SherpaOnnx] patch-libarchive-includes.sh failed. Check that #{libarchive_dir} contains libarchive .c/.h files.")
  end
end
# Libarchive C sources: use patched copies (same exclude as before: test, windows, linux, sunos, freebsd).
libarchive_sources = if File.directory?(patched_dir)
  Dir.glob(File.join(patched_dir, "*.c")).reject { |f|
    base = File.basename(f, ".c")
    File.basename(f) =~ /^test\./ || base.include?("windows") || base.include?("linux") || base.include?("sunos") || base.include?("freebsd")
  }.map { |f| Pathname.new(f).relative_path_from(Pathname.new(pod_root)).to_s.gsub("\\", "/") }
else
  []
end

if libarchive_sources.empty?
  abort("[SherpaOnnx] Libarchive sources missing. Ensure third_party/libarchive_prebuilt/libarchive-ios-layout exists (run third_party/libarchive_prebuilt/build_libarchive_ios.sh) or ios/scripts/setup-ios-libarchive.sh has run, and that ios/scripts/patch-libarchive-includes.sh succeeds. Check pod install logs for patch script errors.")
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

  # Download sherpa-onnx XCFramework from GitHub Releases before pod install (uses IOS_RELEASE_TAG for pinned version).
  s.prepare_command = "bash scripts/setup-ios-framework.sh"

  s.source_files = ["ios/**/*.{h,m,mm,swift,cpp}", *libarchive_sources]
  s.private_header_files = "ios/**/*.h"

  s.frameworks = "Foundation", "Accelerate", "CoreML"
  s.vendored_frameworks = "ios/Frameworks/sherpa_onnx.xcframework"
  xcframework_root = File.join(pod_root, "ios", "Frameworks", "sherpa_onnx.xcframework")
  simulator_headers = File.join(xcframework_root, "ios-arm64_x86_64-simulator", "Headers")
  device_headers = File.join(xcframework_root, "ios-arm64", "Headers")
  simulator_slice = File.join(xcframework_root, "ios-arm64_x86_64-simulator")
  device_slice = File.join(xcframework_root, "ios-arm64")

  s.pod_target_xcconfig = {
    "HEADER_SEARCH_PATHS" => "$(inherited) \"#{pod_root}/ios\" \"#{libarchive_dir}\" \"#{device_headers}\" \"#{simulator_headers}\"",
    "GCC_PREPROCESSOR_DEFINITIONS" => '$(inherited) PLATFORM_CONFIG_H=\\"libarchive_darwin_config.h\\"',
    "CLANG_CXX_LANGUAGE_STANDARD" => "c++17",
    "CLANG_CXX_LIBRARY" => "libc++",
    "LIBRARY_SEARCH_PATHS[sdk=iphoneos*]" => "$(inherited) \"#{device_slice}\"",
    "LIBRARY_SEARCH_PATHS[sdk=iphonesimulator*]" => "$(inherited) \"#{simulator_slice}\"",
    "OTHER_LDFLAGS" => "$(inherited) -lsherpa-onnx"
  }

  s.user_target_xcconfig = {
    "CLANG_CXX_LANGUAGE_STANDARD" => "c++17",
    "CLANG_CXX_LIBRARY" => "libc++",
    "LIBRARY_SEARCH_PATHS[sdk=iphoneos*]" => "$(inherited) \"#{device_slice}\"",
    "LIBRARY_SEARCH_PATHS[sdk=iphonesimulator*]" => "$(inherited) \"#{simulator_slice}\"",
    "OTHER_LDFLAGS" => "$(inherited) -lsherpa-onnx"
  }

  s.libraries = "c++", "z"

  install_modules_dependencies(s)
end