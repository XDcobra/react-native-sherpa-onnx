module.exports = {
  dependency: {
    platforms: {
      android: {
        // ReaderView insert hosts use a hand-written shadow node; both reader
        // descriptors are registered from the custom codegen build below.
        componentDescriptors: [
          'SherpaReaderViewComponentDescriptor',
          'SherpaReaderInsertViewComponentDescriptor',
        ],
        cmakeListsPath: '../android/src/main/jni-codegen/CMakeLists.txt',
      },
      ios: {
        // RN static linkage does not copy a dynamic XCFramework into the app.
        // This phase embeds pdfium.framework when the opt-in prebuilt is present.
        scriptPhases: [
          {
            name: '[SherpaOnnx] Embed pdfium.framework',
            path: './scripts/ios-embed-pdfium.sh',
            execution_position: 'after_compile',
          },
        ],
      },
    },
  },
};
