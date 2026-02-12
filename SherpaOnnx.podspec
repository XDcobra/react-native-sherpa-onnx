require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

# Compute absolute paths
pod_root = __dir__
ios_include_path = File.join(pod_root, 'ios', 'include')
ios_path = File.join(pod_root, 'ios')
framework_path = File.join(pod_root, 'ios', 'Frameworks', 'sherpa_onnx.xcframework')
libarchive_dir = File.join(pod_root, 'android', 'src', 'main', 'cpp', 'libarchive', 'libarchive')
# Libarchive C sources (exclude test/) for vendored build on iOS (no system libarchive)
libarchive_sources = Dir.glob(File.join(libarchive_dir, '*.c')).map { |f| Pathname.new(f).relative_path_from(Pathname.new(pod_root)).to_s.gsub('\\', '/') }

Pod::Spec.new do |s|
  s.name         = "SherpaOnnx"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]

  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/XDcobra/react-native-sherpa-onnx.git", :tag => "#{s.version}" }
  
  # Source files (implementation)
  # Include .cc for cxx-api.cc (C++ wrapper around C API)
  # Include vendored libarchive .c for iOS (system does not provide libarchive)
  s.source_files = ["ios/**/*.{h,m,mm,swift,cpp,cc}", *libarchive_sources]
  
  # Private headers (our wrapper headers)
  s.private_header_files = [
    "ios/*.h",
    "ios/include/**/*.h"
  ]
  
  # Link with required frameworks and libraries
  # CoreML is required by ONNX Runtime's CoreML execution provider
  s.frameworks = 'Foundation', 'Accelerate', 'CoreML'
  # Link zlib (system on iOS); libarchive is built from vendored source above
  s.libraries = 'c++', 'z'
  
  # Note: Header files and framework are set up by postinstall script (yarn setup-assets)
  # This runs automatically after yarn/npm install and handles all setup tasks
  
  # Verify XCFramework exists
  unless File.exist?(framework_path)
    raise <<~MSG
      [SherpaOnnx] ERROR: iOS Framework not found.
      
      The sherpa-onnx XCFramework should have been downloaded automatically during pod install.
      If the automatic download failed, you can manually download it by running:
      
      yarn download-ios-framework
      
      Or download from GitHub Releases:
      https://github.com/XDcobra/react-native-sherpa-onnx/releases?q=framework
      
      Then extract to: #{framework_path}
    MSG
  end
  
  # Log paths for debugging (visible during pod install)
  puts "[SherpaOnnx] Pod root: #{pod_root}"
  puts "[SherpaOnnx] Include path: #{ios_include_path}"
  puts "[SherpaOnnx] Framework path: #{framework_path}"
  framework_version = File.read(File.join(pod_root, 'ios', 'Frameworks', '.framework-version')).strip rescue 'unknown'
  puts "[SherpaOnnx] Framework version: #{framework_version}"
  
  # Use vendored_frameworks for the XCFramework
  s.vendored_frameworks = 'ios/Frameworks/sherpa_onnx.xcframework'
  
  # Preserve headers and config files
  s.preserve_paths = [
    'ios/SherpaOnnx.xcconfig',
    'ios/include/**/*'
  ]
  
  s.pod_target_xcconfig = {
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    'CLANG_CXX_LIBRARY' => 'libc++',
    'HEADER_SEARCH_PATHS' => "$(inherited) \"#{ios_include_path}\" \"#{libarchive_dir}\" \"#{ios_path}\"",
    'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited) PLATFORM_CONFIG_H="libarchive_darwin_config.h"',
  }
  
  s.user_target_xcconfig = {
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    'CLANG_CXX_LIBRARY' => 'libc++',
  }
  
  install_modules_dependencies(s)
end
