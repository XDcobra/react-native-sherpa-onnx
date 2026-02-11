#!/usr/bin/env node
// Short description:
// This script downloads a libarchive release tarball, unpacks it,
// and replaces the bundled source code under android/src/main/cpp/libarchive.
// When to run: Before a release or when libarchive in the project needs to be
// updated to a new version (e.g., to fix build/linker errors).
// Usage: node update.js <version> (e.g., node update.js 3.8.5)
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..', '..');
const version = process.argv[2] || '3.8.5';

const workDir = path.join(rootDir, '.libarchive_tmp');
const archiveName = `libarchive-${version}.tar.xz`;
const archiveUrl = `https://github.com/libarchive/libarchive/releases/download/v${version}/${archiveName}`;
const archivePath = path.join(workDir, archiveName);

const libarchiveDir = path.join(rootDir, 'libarchive');
const templateCmake = path.join(
  rootDir,
  'jni',
  'libarchive_update',
  'CMakeLists-base.txt'
);
const templateConfig = path.join(
  rootDir,
  'jni',
  'libarchive_update',
  'config-base.h'
);

function log(message) {
  process.stdout.write(`${message}\n`);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function removeDir(dirPath) {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

function assertFileExists(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
}

function download(url, destination) {
  return new Promise((resolve, reject) => {
    const fileStream = fs.createWriteStream(destination);
    const request = https.get(url, (response) => {
      if (
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        fileStream.close(() => {
          fs.unlinkSync(destination);
          resolve(download(response.headers.location, destination));
        });
        return;
      }

      if (response.statusCode !== 200) {
        fileStream.close(() => {
          if (fs.existsSync(destination)) {
            fs.unlinkSync(destination);
          }
          reject(
            new Error(`HTTP ${response.statusCode} while downloading ${url}`)
          );
        });
        return;
      }

      response.pipe(fileStream);
      fileStream.on('finish', () => fileStream.close(resolve));
    });

    request.on('error', (error) => {
      fileStream.close(() => {
        if (fs.existsSync(destination)) {
          fs.unlinkSync(destination);
        }
        reject(error);
      });
    });
  });
}

function runTar(args, cwd) {
  const result = spawnSync('tar', args, { stdio: 'inherit', cwd });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`tar failed with exit code ${result.status}`);
  }
}

async function main() {
  log(`Updating libarchive to v${version}...`);

  assertFileExists(templateCmake, 'Template CMakeLists');
  assertFileExists(templateConfig, 'Template config.h');

  removeDir(workDir);
  ensureDir(workDir);

  log(`Downloading ${archiveUrl}`);
  await download(archiveUrl, archivePath);

  log('Extracting archive...');
  runTar(['-xf', archivePath, '-C', workDir], rootDir);

  const extractedDir = path.join(workDir, `libarchive-${version}`);
  if (!fs.existsSync(extractedDir)) {
    throw new Error('Extracted directory not found.');
  }

  log('Replacing existing libarchive directory...');
  removeDir(libarchiveDir);
  fs.cpSync(extractedDir, libarchiveDir, { recursive: true });

  log('Applying template CMakeLists.txt...');
  fs.copyFileSync(templateCmake, path.join(libarchiveDir, 'CMakeLists.txt'));

  log('Applying template config.h...');
  fs.copyFileSync(templateConfig, path.join(libarchiveDir, 'config.h'));

  removeDir(workDir);

  log(`Done. libarchive updated to v${version}.`);
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
});
