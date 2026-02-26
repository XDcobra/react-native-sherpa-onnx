require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

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

  s.source_files = ["ios/**/*.{h,m,mm,swift,cpp}"]
  s.private_header_files = "ios/**/*.h"

  install_modules_dependencies(s)
end