#!/usr/bin/env node
// Copies libarchive prebuilt .so and headers into android/src/main/jniLibs/<abi>/ and cpp/include/libarchive/.
// Usage: node copy_prebuilts_to_sdk.js

const fs = require('fs')
const path = require('path')

const abis = ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64']
const repoRoot = path.resolve(__dirname, '..', '..')
const prebuiltRoot = path.join(__dirname, 'android')
const sdkJniLibsRoot = path.join(repoRoot, 'android', 'src', 'main', 'jniLibs')
const sdkIncludeRoot = path.join(repoRoot, 'android', 'src', 'main', 'cpp', 'include', 'libarchive')

function copyDir(srcDir, dstDir) {
  if (!fs.existsSync(srcDir)) return false
  fs.mkdirSync(dstDir, { recursive: true })
  const files = fs.readdirSync(srcDir)
  let any = false
  files.forEach(f => {
    if (!f.endsWith('.so')) return
    const src = path.join(srcDir, f)
    const dst = path.join(dstDir, f)
    fs.copyFileSync(src, dst)
    console.log(`copied ${path.relative(repoRoot, src)} -> ${path.relative(repoRoot, dst)}`)
    any = true
  })
  return any
}

function main() {
  console.log('Repo root:', repoRoot)
  console.log('Prebuilt root:', prebuiltRoot)
  console.log('SDK jniLibs root:', sdkJniLibsRoot)
  console.log('SDK include root:', sdkIncludeRoot)

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

  const includeSrc = path.join(prebuiltRoot, 'include')
  if (fs.existsSync(includeSrc)) {
    fs.mkdirSync(sdkIncludeRoot, { recursive: true })
    const entries = fs.readdirSync(includeSrc, { withFileTypes: true })
    entries.forEach(e => {
      const src = path.join(includeSrc, e.name)
      const dst = path.join(sdkIncludeRoot, e.name)
      if (e.isDirectory()) {
        if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true })
        const sub = fs.readdirSync(src, { withFileTypes: true })
        sub.forEach(s => {
          const ssrc = path.join(src, s.name)
          const ddst = path.join(dst, s.name)
          if (s.isFile()) {
            fs.copyFileSync(ssrc, ddst)
            console.log(`copied include ${path.relative(includeSrc, ssrc)}`)
          }
        })
      } else {
        fs.copyFileSync(src, dst)
        console.log(`copied include ${e.name}`)
      }
    })
    any = true
  }

  if (!any) {
    console.error('No .so or include files copied. Run build_libarchive_android.sh first.')
    process.exit(2)
  }

  console.log('Done.')
}

if (require.main === module) main()
