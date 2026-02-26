require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))
pod_root = __dir__
# Android-style fallback: prefer local third_party, else use downloaded ios/Downloads/libarchive (from setup-ios-libarchive.sh, run in Podfile pre_install).
libarchive_third_party = File.join(pod_root, "third_party", "libarchive", "libarchive")
libarchive_downloads = File.join(pod_root, "ios", "Downloads", "libarchive")
libarchive_dir = File.directory?(libarchive_third_party) ? libarchive_third_party : libarchive_downloads
# Libarchive C sources for iOS: exclude test/, Windows, and non-Darwin platform files.
libarchive_sources = if File.directory?(libarchive_dir)
  Dir.glob(File.join(libarchive_dir, "*.c")).reject { |f|
    base = File.basename(f, ".c")
    File.basename(f) =~ /^test\./ || base.include?("windows") || base.include?("linux") || base.include?("sunos") || base.include?("freebsd")
  }.map { |f| Pathname.new(f).relative_path_from(Pathname.new(pod_root)).to_s.gsub("\\", "/") }
else
  []
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

  s.pod_target_xcconfig = {
    "HEADER_SEARCH_PATHS" => "$(inherited) \"#{pod_root}/ios\" \"#{libarchive_dir}\"",
    "GCC_PREPROCESSOR_DEFINITIONS" => '$(inherited) PLATFORM_CONFIG_H="libarchive_darwin_config.h"'
  }

  s.libraries = "c++", "z"

  install_modules_dependencies(s)
end