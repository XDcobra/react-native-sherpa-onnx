#!/usr/bin/env node
// Copies FFmpeg prebuilt .so files into android/src/main/jniLibs/<abi>/
// Usage: node copy_prebuilts_to_sdk.js

const fs = require('fs')
const path = require('path')

const abis = ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64']
const repoRoot = path.resolve(__dirname, '..', '..')
const prebuiltRoot = path.join(__dirname, 'android')
const sdkJniLibsRoot = path.join(repoRoot, 'android', 'src', 'main', 'jniLibs')

function copyDir(srcDir, dstDir) {
  if (!fs.existsSync(srcDir)) return false
  fs.mkdirSync(dstDir, { recursive: true })
  const files = fs.readdirSync(srcDir)
  files.forEach(f => {
    if (!f.endsWith('.so')) return
    const src = path.join(srcDir, f)
    const dst = path.join(dstDir, f)
    fs.copyFileSync(src, dst)
    console.log(`copied ${src} -> ${dst}`)
  })
  return true
}

function main() {
  console.log('Repo root:', repoRoot)
  console.log('Prebuilt root:', prebuiltRoot)
  console.log('SDK jniLibs root:', sdkJniLibsRoot)

  let any = false
  abis.forEach(abi => {
    const srcLibDir = path.join(prebuiltRoot, abi, 'lib')
    const dstLibDir = path.join(sdkJniLibsRoot, abi)
    if (!fs.existsSync(srcLibDir)) {
      console.warn(`source ABI folder missing: ${srcLibDir}`)
      return
    }
    console.log(`Installing ABI ${abi}`)
    const ok = copyDir(srcLibDir, dstLibDir)
    if (ok) any = true
  })

  if (!any) {
    console.error('No .so files copied. Check that third_party/ffmpeg_prebuilt/android/<abi>/lib exists.')
    process.exit(2)
  }

  console.log('Done.')
}

if (require.main === module) main()
