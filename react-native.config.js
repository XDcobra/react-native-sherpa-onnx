module.exports = {
  dependency: {
    platforms: {
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
