#!/usr/bin/env node

/**
 * Copies sherpa-onnx C API headers (and cxx-api.cc) to iOS only.
 * Android headers come from the GitHub release (sherpa-onnx-android.zip) and are
 * extracted by Gradle when native libs are downloaded. See android/build.gradle.
 * This script ensures iOS headers are available for prepack/npm and local dev.
 */

const fs = require('fs');
const path = require('path');

const SOURCE_DIR = path.join(
  __dirname,
  '..',
  'third_party',
  'sherpa-onnx',
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

function areIOSHeadersPresent() {
  const required = [
    path.join(IOS_DEST_DIR, 'c-api.h'),
    path.join(IOS_DEST_DIR, 'cxx-api.h'),
    path.join(IOS_ROOT_DIR, CXX_IMPL_FILE),
  ];
  return required.every((file) => fs.existsSync(file));
}

function main() {
  console.log('Checking sherpa-onnx iOS header files...\n');

  if (areIOSHeadersPresent()) {
    console.log('iOS header files already present, skipping copy.');
    console.log('  iOS: ios/include/sherpa-onnx/c-api/ and ios/cxx-api.cc');
    return;
  }

  console.log('Copying from git submodule to iOS...\n');

  if (!fs.existsSync(SOURCE_DIR)) {
    console.error(`Error: Source directory not found: ${SOURCE_DIR}`);
    console.error('Initialize submodule: git submodule update --init --recursive');
    console.error('Android headers are provided by Gradle from the GitHub release.');
    process.exit(1);
  }

  ensureDirectoryExists(IOS_DEST_DIR);

  let successCount = 0;
  let failCount = 0;

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
    console.log('iOS header files copied successfully!');
  }
}

main();
