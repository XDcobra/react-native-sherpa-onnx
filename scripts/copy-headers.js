#!/usr/bin/env node

/**
 * Script to copy sherpa-onnx header files to Android and iOS include directories.
 * This ensures that the headers are available when the package is published to npm,
 * even if the git submodule is not initialized.
 */

const fs = require('fs');
const path = require('path');

const SOURCE_DIR = path.join(
  __dirname,
  '..',
  'sherpa-onnx',
  'sherpa-onnx',
  'c-api'
);
const ANDROID_DEST_DIR = path.join(
  __dirname,
  '..',
  'android',
  'src',
  'main',
  'cpp',
  'include',
  'sherpa-onnx',
  'c-api'
);
const IOS_DEST_DIR = path.join(
  __dirname,
  '..',
  'ios',
  'include',
  'sherpa-onnx',
  'c-api'
);

const HEADER_FILES = ['c-api.h', 'cxx-api.h'];

// C++ API implementation file needed for iOS (compiles the C++ wrapper around C API)
const CXX_IMPL_FILE = 'cxx-api.cc';
const IOS_ROOT_DIR = path.join(__dirname, '..', 'ios');

function ensureDirectoryExists(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    console.log(`Created directory: ${dirPath}`);
  }
}

function copyFile(source, destination) {
  try {
    fs.copyFileSync(source, destination);
    console.log(
      `Copied: ${path.basename(source)} -> ${path.relative(
        process.cwd(),
        destination
      )}`
    );
    return true;
  } catch (error) {
    console.error(`Failed to copy ${source}:`, error.message);
    return false;
  }
}

function areHeadersAlreadyPresent() {
  // Check if all critical headers are already in the destination directories
  const requiredFiles = [
    path.join(ANDROID_DEST_DIR, 'c-api.h'),
    path.join(IOS_DEST_DIR, 'c-api.h'),
    path.join(IOS_DEST_DIR, 'cxx-api.h'),
  ];

  return requiredFiles.every((file) => fs.existsSync(file));
}

function main() {
  console.log('Checking sherpa-onnx header files...\n');

  // Check if headers are already present (e.g., from npm package)
  if (areHeadersAlreadyPresent()) {
    console.log('Header files already present, skipping copy.');
    console.log('  Android: android/src/main/cpp/include/sherpa-onnx/c-api/');
    console.log('  iOS:     ios/include/sherpa-onnx/c-api/');
    return;
  }

  console.log(
    'Header files not found, attempting to copy from git submodule...\n'
  );

  // Check if source directory exists
  if (!fs.existsSync(SOURCE_DIR)) {
    console.error(`Error: Source directory not found: ${SOURCE_DIR}`);
    console.error('Possible causes:');
    console.error('  1. Git submodule is not initialized');
    console.error(
      '  2. You are using an npm package (headers should already be included)'
    );
    console.error('');
    console.error('Solutions:');
    console.error(
      '  • Initialize submodule: git submodule update --init --recursive'
    );
    console.error(
      '  • Check if headers exist in ios/include/ or android/.../include/'
    );
    process.exit(1);
  }

  // Ensure destination directories exist
  ensureDirectoryExists(ANDROID_DEST_DIR);
  ensureDirectoryExists(IOS_DEST_DIR);

  let successCount = 0;
  let failCount = 0;

  // Copy header files to Android
  console.log('Copying to Android...');
  for (const headerFile of HEADER_FILES) {
    const source = path.join(SOURCE_DIR, headerFile);
    const destination = path.join(ANDROID_DEST_DIR, headerFile);

    if (!fs.existsSync(source)) {
      console.error(`Source file not found: ${source}`);
      failCount++;
      continue;
    }

    if (copyFile(source, destination)) {
      successCount++;
    } else {
      failCount++;
    }
  }

  // Copy header files to iOS
  console.log('\nCopying to iOS...');
  for (const headerFile of HEADER_FILES) {
    const source = path.join(SOURCE_DIR, headerFile);
    const destination = path.join(IOS_DEST_DIR, headerFile);

    if (!fs.existsSync(source)) {
      console.error(`Source file not found: ${source}`);
      failCount++;
      continue;
    }

    if (copyFile(source, destination)) {
      successCount++;
    } else {
      failCount++;
    }
  }

  // Copy C++ API implementation to iOS root (needed for compilation)
  console.log('\nCopying C++ API implementation to iOS...');
  const cxxImplSource = path.join(SOURCE_DIR, CXX_IMPL_FILE);
  const cxxImplDest = path.join(IOS_ROOT_DIR, CXX_IMPL_FILE);

  if (!fs.existsSync(cxxImplSource)) {
    console.error(`Source file not found: ${cxxImplSource}`);
    failCount++;
  } else if (copyFile(cxxImplSource, cxxImplDest)) {
    successCount++;
  } else {
    failCount++;
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(
    `Summary: ${successCount} files copied successfully, ${failCount} failed`
  );

  if (failCount > 0) {
    process.exit(1);
  } else {
    console.log('All header files copied successfully!');
  }
}

main();
