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
 * Verify header files are in the correct locations
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
    path.join(
      __dirname,
      '..',
      'android',
      'src',
      'main',
      'cpp',
      'include',
      'sherpa-onnx',
      'c-api',
      'c-api.h'
    ),
    path.join(
      __dirname,
      '..',
      'android',
      'src',
      'main',
      'cpp',
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
    log('All header files verified at correct locations', 'success');
    return true;
  } else {
    log(
      `Missing header files found (${missingHeaders.length}/${requiredHeaders.length}):`,
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
