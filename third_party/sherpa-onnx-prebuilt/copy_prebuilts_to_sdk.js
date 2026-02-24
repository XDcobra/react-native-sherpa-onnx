#!/usr/bin/env node
// Copies sherpa-onnx prebuilt .so files into android/src/main/jniLibs/<abi>/
// Usage: node copy_prebuilts_to_sdk.js

const fs = require('fs');
const path = require('path');

const abis = ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64'];
const requiredSoFiles = [
  'libsherpa-onnx-jni.so',
  'libsherpa-onnx-c-api.so',
  'libsherpa-onnx-cxx-api.so',
  'libonnxruntime.so',
];

const repoRoot = path.resolve(__dirname, '..', '..');
const prebuiltRoot = path.join(__dirname, 'android');
const sdkJniLibsRoot = path.join(repoRoot, 'android', 'src', 'main', 'jniLibs');

function copyDir(srcDir, dstDir) {
  if (!fs.existsSync(srcDir)) return false;
  fs.mkdirSync(dstDir, { recursive: true });
  let copied = 0;
  const files = fs.readdirSync(srcDir);
  files.forEach((f) => {
    if (!f.endsWith('.so')) return;
    const src = path.join(srcDir, f);
    const dst = path.join(dstDir, f);
    const srcStat = fs.statSync(src);
    let doCopy = true;
    if (fs.existsSync(dst)) {
      const dstStat = fs.statSync(dst);
      if (srcStat.size === dstStat.size && srcStat.mtimeMs <= dstStat.mtimeMs) {
        doCopy = false;
      }
    }
    if (doCopy) {
      fs.copyFileSync(src, dst);
      console.log(`copied ${path.relative(prebuiltRoot, src)} -> ${path.relative(repoRoot, dst)}`);
      copied++;
    }
  });
  return copied > 0;
}

function main() {
  console.log('Repo root:', repoRoot);
  console.log('Prebuilt root:', prebuiltRoot);
  console.log('SDK jniLibs root:', sdkJniLibsRoot);

  let any = false;
  abis.forEach((abi) => {
    const srcLibDir = path.join(prebuiltRoot, abi, 'lib');
    const dstLibDir = path.join(sdkJniLibsRoot, abi);
    if (!fs.existsSync(srcLibDir)) {
      console.warn(`source ABI folder missing: ${srcLibDir}`);
      return;
    }
    const missing = requiredSoFiles.filter((so) => !fs.existsSync(path.join(srcLibDir, so)));
    if (missing.length > 0) {
      console.warn(`ABI ${abi}: missing in prebuilts: ${missing.join(', ')}`);
    }
    console.log(`Installing ABI ${abi}`);
    const ok = copyDir(srcLibDir, dstLibDir);
    if (ok) any = true;
  });

  if (!any) {
    console.error(
      'No .so files copied. Build sherpa-onnx first: cd third_party/sherpa-onnx-prebuilt && ./build_sherpa_onnx.sh (see README.md for --qnn)'
    );
    process.exit(2);
  }

  console.log('Done.');
}

if (require.main === module) main();
