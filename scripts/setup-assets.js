#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// platform detection not needed currently

/**
 * Setup script that runs after npm/yarn install
 * Handles:
 * 1. Copying C++ header files from sherpa-onnx submodule
 * 2. Downloading iOS framework from GitHub releases
 */

function log(message, type = 'info') {
  const colors = {
    info: '\x1b[36m', // cyan
    success: '\x1b[32m', // green
    warning: '\x1b[33m', // yellow
    error: '\x1b[31m', // red
    reset: '\x1b[0m',
  };

  const color = colors[type] || colors.info;
  console.log(`${color}[setup-assets] ${message}${colors.reset}`);
}

/**
 * Run a command and return output
 */
function runCommand(cmd, options = {}) {
  const { silent = false, allowFailure = false } = options;

  try {
    if (!silent) {
      log(`Running: ${cmd}`);
    }

    const output = execSync(cmd, {
      encoding: 'utf-8',
      stdio: silent ? 'pipe' : 'inherit',
    });

    return { ok: true, output: (output || '').trim() };
  } catch (error) {
    if (!silent) {
      log(
        `${allowFailure ? 'Warning' : 'Failed'}: ${cmd}`,
        allowFailure ? 'warning' : 'error'
      );
    }

    if (!allowFailure) {
      throw error;
    }

    return { ok: false, output: '' };
  }
}

/**
 * Verify iOS header files are in the correct locations.
 * Android headers are provided by Gradle from the GitHub release (sherpa-onnx-android.zip).
 */
function verifyHeaders() {
  log('Verifying header files...', 'info');

  const requiredHeaders = [
    path.join(
      __dirname,
      '..',
      'ios',
      'include',
      'sherpa-onnx',
      'c-api',
      'c-api.h'
    ),
    path.join(
      __dirname,
      '..',
      'ios',
      'include',
      'sherpa-onnx',
      'c-api',
      'cxx-api.h'
    ),
  ];

  const missingHeaders = requiredHeaders.filter(
    (header) => !fs.existsSync(header)
  );

  if (missingHeaders.length === 0) {
    log('iOS header files verified at correct locations', 'success');
    return true;
  } else {
    log(
      `Missing iOS header files (${missingHeaders.length}/${requiredHeaders.length}):`,
      'error'
    );
    missingHeaders.forEach((header) => {
      log(`  - ${header}`, 'error');
    });
    return false;
  }
}

/**
 * Step 1: Copy header files
 */
function copyHeaders() {
  log('Step 1: Copying header files...', 'info');

  try {
    // Call the script directly to avoid depending on yarn availability in consumers
    const copyResult = runCommand('node scripts/copy-headers.js', {
      allowFailure: true,
    });

    if (copyResult.ok) {
      log('Header files copied successfully', 'success');
    } else {
      log(
        'Warning: Header copy command reported a failure; verifying files...',
        'warning'
      );
    }

    // Verify headers after copy
    console.log('');
    const headersOk = verifyHeaders();
    if (!headersOk) {
      log('Header verification failed after copy', 'error');
    }
    return headersOk;
  } catch {
    log('Warning: Header copy failed, may already exist', 'warning');
    // Still try to verify if headers exist
    console.log('');
    return verifyHeaders();
  }
}

/**
 * Verify iOS framework is downloaded and extracted correctly
 */
function verifyIOSFramework() {
  log('Verifying iOS framework...', 'info');

  const frameworkPath = path.join(
    __dirname,
    '..',
    'ios',
    'Frameworks',
    'sherpa_onnx.xcframework'
  );

  // Check if framework directory exists
  if (!fs.existsSync(frameworkPath)) {
    log(`Framework directory not found at ${frameworkPath}`, 'error');
    return false;
  }

  log(`Framework directory exists`, 'success');

  // Check for required framework files
  const requiredFiles = [
    path.join(frameworkPath, 'Info.plist'),
    path.join(frameworkPath, 'ios-arm64', 'libsherpa-onnx.a'),
    path.join(frameworkPath, 'ios-arm64_x86_64-simulator', 'libsherpa-onnx.a'),
  ];

  const missingFiles = requiredFiles.filter((file) => !fs.existsSync(file));

  if (missingFiles.length === 0) {
    // Calculate framework size
    let totalSize = 0;
    const getDirectorySize = (dirPath) => {
      try {
        const files = fs.readdirSync(dirPath);
        files.forEach((file) => {
          const filePath = path.join(dirPath, file);
          const stats = fs.statSync(filePath);
          if (stats.isDirectory()) {
            totalSize += getDirectorySize(filePath);
          } else {
            totalSize += stats.size;
          }
        });
      } catch {
        // Silently ignore errors
      }
      return totalSize;
    };

    getDirectorySize(frameworkPath);
    const frameworkSizeMB = (totalSize / (1024 * 1024)).toFixed(2);

    log(`All framework files present (${frameworkSizeMB}MB)`, 'success');
    return true;
  } else {
    log(
      `Missing framework files (${missingFiles.length}/${requiredFiles.length}):`,
      'error'
    );
    missingFiles.forEach((file) => {
      log(`  - ${file}`, 'error');
    });
    return false;
  }
}

/**
 * Step 2: Download iOS framework (only on macOS)
 */
function downloadIOSFramework() {
  // Only download on macOS since it's iOS-specific
  if (process.platform !== 'darwin') {
    log('Skipping iOS framework download (not on macOS)', 'info');
    return true;
  }

  log('Step 2: Downloading iOS framework...', 'info');

  const frameworkPath = path.join(
    __dirname,
    '..',
    'ios',
    'Frameworks',
    'sherpa_onnx.xcframework'
  );

  // Check if framework already exists
  if (fs.existsSync(frameworkPath)) {
    log('iOS framework already present, verifying...', 'success');
    console.log('');
    return verifyIOSFramework();
  }

  try {
    // Call the shell script directly to avoid yarn dependency in consuming apps
    const downloadResult = runCommand('bash scripts/setup-ios-framework.sh');

    if (downloadResult.ok) {
      log('iOS framework downloaded successfully', 'success');

      // Verify framework after download
      console.log('');
      return verifyIOSFramework();
    }

    log('iOS framework download command reported failure', 'error');
    return false;
  } catch {
    log('iOS framework download failed', 'error');
    return false;
  }
}

/**
 * Step 3: Copy FFmpeg prebuilt .so files to android/src/main/jniLibs/
 *
 * The FFmpeg prebuilts must be built first (third_party/ffmpeg_prebuilt/build_ffmpeg.sh).
 * This step is non-fatal: if prebuilts are not built yet, it warns and continues.
 * CI workflows (sdk-android.yml, maven-build.yml) build FFmpeg from source before this.
 */
function copyFfmpegPrebuilts() {
  log('Step 3: Copying FFmpeg prebuilt .so files...', 'info');

  const prebuiltRoot = path.join(
    __dirname,
    '..',
    'third_party',
    'ffmpeg_prebuilt',
    'android'
  );
  const jniLibsRoot = path.join(
    __dirname,
    '..',
    'android',
    'src',
    'main',
    'jniLibs'
  );

  // Check if any prebuilt ABI directory exists with .so files
  const abis = ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64'];
  const hasPrebuilts = abis.some((abi) => {
    const libDir = path.join(prebuiltRoot, abi, 'lib');
    return fs.existsSync(libDir);
  });

  if (!hasPrebuilts) {
    log('FFmpeg prebuilts not found at ' + prebuiltRoot, 'warning');
    log(
      'Build them with: cd third_party/ffmpeg_prebuilt && ./build_ffmpeg.sh',
      'warning'
    );
    log(
      'Then run: node third_party/ffmpeg_prebuilt/copy_prebuilts_to_sdk.js',
      'warning'
    );
    return true; // non-fatal
  }

  // Check if jniLibs already populated (idempotent)
  const sampleSo = path.join(jniLibsRoot, 'arm64-v8a', 'libavcodec.so');
  if (fs.existsSync(sampleSo)) {
    log('FFmpeg .so files already present in jniLibs/', 'success');
    return true;
  }

  try {
    const copyScript = path.join(
      __dirname,
      '..',
      'third_party',
      'ffmpeg_prebuilt',
      'copy_prebuilts_to_sdk.js'
    );
    const copyResult = runCommand(`node "${copyScript}"`, {
      allowFailure: true,
    });

    if (copyResult.ok) {
      log('FFmpeg prebuilt .so files copied to jniLibs/', 'success');
    } else {
      log(
        'Warning: FFmpeg prebuilt copy had issues; check output above',
        'warning'
      );
    }
    return true;
  } catch {
    log('Warning: FFmpeg prebuilt copy failed (non-fatal)', 'warning');
    return true; // non-fatal — user may not have built FFmpeg yet
  }
}

/**
 * Step 4: Copy sherpa-onnx prebuilt .so files to android/src/main/jniLibs/
 *
 * Prebuilts must be built first (third_party/sherpa-onnx-prebuilt/build_sherpa_onnx.sh).
 * Non-fatal: if prebuilts are not built yet, warns and continues.
 * npm consumers get prebuilts from the package; devs build and copy.
 */
function copySherpaOnnxPrebuilts() {
  log('Step 4: Copying sherpa-onnx prebuilt .so files...', 'info');

  const prebuiltRoot = path.join(
    __dirname,
    '..',
    'third_party',
    'sherpa-onnx-prebuilt',
    'android'
  );
  const jniLibsRoot = path.join(
    __dirname,
    '..',
    'android',
    'src',
    'main',
    'jniLibs'
  );

  const abis = ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64'];
  const hasPrebuilts = abis.some((abi) => {
    const libDir = path.join(prebuiltRoot, abi, 'lib');
    return fs.existsSync(libDir);
  });

  if (!hasPrebuilts) {
    log('sherpa-onnx prebuilts not found at ' + prebuiltRoot, 'warning');
    log(
      'Build them with: cd third_party/sherpa-onnx-prebuilt && ./build_sherpa_onnx.sh (optional: --qnn for Qualcomm NPU; requires QNN_SDK_ROOT)',
      'warning'
    );
    log(
      'Then run: node third_party/sherpa-onnx-prebuilt/copy_prebuilts_to_sdk.js',
      'warning'
    );
    return true; // non-fatal
  }

  const sampleSo = path.join(jniLibsRoot, 'arm64-v8a', 'libsherpa-onnx-jni.so');
  if (fs.existsSync(sampleSo)) {
    log('sherpa-onnx .so files already present in jniLibs/', 'success');
    return true;
  }

  try {
    const copyScript = path.join(
      __dirname,
      '..',
      'third_party',
      'sherpa-onnx-prebuilt',
      'copy_prebuilts_to_sdk.js'
    );
    const copyResult = runCommand(`node "${copyScript}"`, {
      allowFailure: true,
    });

    if (copyResult.ok) {
      log('sherpa-onnx prebuilt .so files copied to jniLibs/', 'success');
    } else {
      log(
        'Warning: sherpa-onnx prebuilt copy had issues; check output above',
        'warning'
      );
    }
    return true;
  } catch {
    log('Warning: sherpa-onnx prebuilt copy failed (non-fatal)', 'warning');
    return true; // non-fatal
  }
}

/**
 * Main setup function
 */
function setup() {
  console.log('');
  log('='.repeat(60), 'info');
  log('SherpaOnnx SDK Setup Starting', 'info');
  log('='.repeat(60), 'info');
  console.log('');

  let success = true;

  // Step 1: Copy headers (critical for both Android and iOS)
  if (!copyHeaders()) {
    success = false;
  }

  console.log('');

  // Step 2: Download iOS framework (macOS only)
  if (!downloadIOSFramework()) {
    success = false;
  }

  console.log('');

  // Step 3: Copy FFmpeg prebuilt .so to jniLibs (non-fatal if prebuilts not built yet)
  copyFfmpegPrebuilts();

  console.log('');

  // Step 4: Copy sherpa-onnx prebuilt .so to jniLibs (non-fatal if prebuilts not built yet)
  copySherpaOnnxPrebuilts();

  console.log('');
  if (success) {
    log('='.repeat(60), 'success');
    log('Setup completed successfully!', 'success');
    log('='.repeat(60), 'success');
    console.log('');
    process.exit(0);
  } else {
    log('Setup failed (see logs above)', 'error');
    console.log('');
    process.exit(1);
  }
}

// Run setup
setup();
