#!/usr/bin/env node
// Copies FFmpeg prebuilt .so files into android/src/main/jniLibs/<abi>/
// Usage: node copy_prebuilts_to_sdk.js

const fs = require('fs')
const path = require('path')

const abis = ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64']
const repoRoot = path.resolve(__dirname, '..', '..')
const prebuiltRoot = path.join(__dirname, 'android')
const sdkJniLibsRoot = path.join(repoRoot, 'android', 'src', 'main', 'jniLibs')

// Additional standalone libraries that may be built separately (e.g. libshine)
const extraSoFiles = ['libshine.so']

// Shine prebuilt root (sibling under third_party)
const shinePrebuiltRoot = path.join(__dirname, '..', 'shine_prebuilt', 'android')

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

    // Ensure extra standalone .so files (like libshine.so) are copied if present
    extraSoFiles.forEach(soName => {
      const dstSoPath = path.join(dstLibDir, soName)
      if (fs.existsSync(dstSoPath)) return // already copied

      // Known ABI-specific locations for extra libs (no recursive search needed)
      const ffmpegAbiSo = path.join(prebuiltRoot, abi, 'lib', soName)
      const ffmpegRootSo = path.join(prebuiltRoot, 'lib', soName)
      const shineAbiSo = path.join(shinePrebuiltRoot, abi, 'lib', soName)
      const shineRootSo = path.join(shinePrebuiltRoot, 'lib', soName)

      let found = null
      if (fs.existsSync(ffmpegAbiSo)) found = ffmpegAbiSo
      else if (fs.existsSync(ffmpegRootSo)) found = ffmpegRootSo
      else if (fs.existsSync(shineAbiSo)) found = shineAbiSo
      else if (fs.existsSync(shineRootSo)) found = shineRootSo

      if (found) {
        try {
          fs.copyFileSync(found, dstSoPath)
          console.log(`copied extra ${found} -> ${dstSoPath}`)
          any = true
        } catch (err) {
          console.warn(`Failed to copy ${found} -> ${dstSoPath}: ${err}`)
        }
      } else {
        console.log(`Extra library ${soName} not found for ABI ${abi}`)
      }
    })
  })

  if (!any) {
    console.error('No .so files copied. Check that third_party/ffmpeg_prebuilt/android/<abi>/lib exists.')
    process.exit(2)
  }

  console.log('Done.')
}

if (require.main === module) main()
