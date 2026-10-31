# Shared HW/SW codec layer — implementation plan

**Status:** Phases 0–5 implemented in tree (2026-10-31). Shared C++ core, Android/iOS providers, opt-in `ffmpeg-vsw`, image backends, public docs. Smoke S0–S5 green on A142P + iOS Simulator: [hw-sw-codec-smoke-a142p-2026-10-31.md](./hw-sw-codec-smoke-a142p-2026-10-31.md). Benches B1–B9 and a real iPhone remain user-run and do not block. Phase 6 optional (not done). Phase 7 skipped (audio still Kotlin).  
**Branch:** `feat/videobuffer-hw-slot-caps` (from `refactor/refactor-before-release-1-0` @ `d679d5c7`).  
**Findings:** [hw-sw-codec-findings.md](./hw-sw-codec-findings.md). Read §1, §7 and §8 there first.  
**Supersedes:** the Cursor plan *HW slot public API* (`hw_slot_public_api_b461b36f`). Its four todos (auto caps, encoder pool, fail-fast + slot events, tests/docs) become Phase 1 here. Its non-goal "no silent SW fallback" still holds: fallback exists only under an explicit `preferHardware` policy and is always reported.

Phases are implementation order inside **one** epic and one release, not separate product releases. Image and video ship together with the same policy logic (D1). Phase 6 is the only optional phase.

Rules that apply to every phase: debug-first (instrument → logcat on Android first → minimal fix), no SDK API change outside what this plan lists, no GPL, no commits without review, and the user builds the example app.

**Device tests never block the plan (decided 2026-10-31).** S0–S5 are recorded (A142P + iOS Simulator, 2026-10-31). Remaining user-run items: benches B1–B9, real iPhone (VT HW decode / reclaim), S4.2 with vsw off, S5.2/S5.3 on API 26/28. Implementation moves to the next phase once the agent-side checks pass (§3). A failing remaining smoke item becomes a normal debug-first bug. Where a phase needs a number that only a device can give, the plan names the default used until it is measured.

---

## 0. Decisions

Recommended values. Items marked **confirm** change public behavior and need a yes before the phase that uses them. **SDK default policy is `preferHardware`** for every media and use (D1).

| # | Decision | Recommendation | Why |
| --- | --- | --- | --- |
| D1 | Defaults | **confirmed 2026-10-31:** `preferHardware` for every use (video `decode` / `display` / `encode`, image `decode`). One rule for all media. Conditions: every fallback is reported (decision + `fallback` event), and B7–B9 are release smoke gates (§5.1) run by the user. They do not block implementation and do not flip the default later; a failure is fixed in the backend or by ranking, not by changing the policy | Same logic everywhere, most robust on unknown devices. Not silent, because the chosen tier is always reported, and `hardware` stays available as the strict mode |
| D2 | Public vocabulary | `CodecPolicy = 'hardware' \| 'software' \| 'preferHardware'`. Reported tier `'hardware' \| 'software' \| 'unknown'`, origin `'platform' \| 'bundled'` | Matches your three modes. Mirrors WebCodecs `prefer-hardware`, but strict. For images, "hardware" means OS codec (`AImageDecoder` / ImageIO), "software" means SDK-bundled (stb / libwebp) |
| D3 | Where the policy is set | Cascade: **operation option > buffer option > `configureCodecs` global > SDK default**. Resolved once per session open, logged | Buffers own sticky decoders, so a buffer default is natural. Single calls (export, preview) still need overrides |
| D4 | Order inside the SW tier | platform SW first, bundled second. Fixed order, logged, not configurable in v1 | Platform SW costs no binary size and carries no patent surface. Bundled covers what platform caps exclude |
| D5 | Bundled SW video decoders | FFmpeg `h264` + `hevc` in an **opt-in prebuilt variant**, default off. Availability is detected at runtime with `avcodec_find_decoder`, never by a compile flag alone. **confirmed 2026-10-31** | Today's prebuilts do not contain these decoders (`--disable-everything` + audio decoders only). The LGPL license allows commercial use; the open point is H.264/HEVC **patents**, which an LGPL license does not grant (findings §3.3). Default install size unchanged; "lib excluded" maps to `VIDEO_SW_DECODER_DISABLED` |
| D6 | Fallback triggers | Exactly findings §7. Mid-stream decode switch at most once per session; encode switches only before the first packet | Deterministic; MP4 cannot change sample description mid-file |
| D7 | Platform caps | **confirmed 2026-10-31:** size / alignment / block-count / profile caps are **authoritative** for skipping a provider (reason `unsupported-stream`). Bitrate caps are logged only. No "try anyway" | CTS backs the advertised caps; outside them behavior varies per device. Consequence on A142P: SW H.264 export ≤ ~720×576 unless the bundled variant gains an encoder later |
| D8 | Contention | Fail-fast everywhere: CPU decode acquire timeout 0 (today 5 s), display unchanged, new encode pool. Consumers wait on `slotFreed` events | Your earlier choice (option B) |
| D9 | Old API | **confirmed 2026-10-31:** move `configureVideoBuffer({ decoderBudget })` into `configureCodecs({ budgets })` and remove the old field before 1.0 | Unreleased SDK; two ways to set the same cap would drift |
| D10 | iOS strictness | iOS 17.0+ decode / 17.4+ encode: `hardware` sets `Require…`, `software` sets `Enable… = false`, and the session reports `Using…`. Older iOS: `hardware` = legacy create, reported tier `unknown`; platform SW provider unavailable (`os-too-old`) | Only way to be strict where the OS allows it, honest where it doesn't |
| D11 | SW caps | separate resource classes for SW; table in §1.4 | SW competes with ONNX for CPU |
| D12 | Image platform class | `platform.image.decode`, cap 2 | Platform HEIC uses the HEVC HW block outside our video pool |

---

## 1. Target architecture

### 1.1 Layout

```
android/src/main/cpp/codec/            (new, shared by Android + iOS + host tests)
  CodecTypes.h        enums + structs (no platform includes)
  CodecLog.h          tag SherpaOnnxCodec, messages "codec.<phase> …", gated like VIDEO_LOGI
  CodecCatalog.{h,cpp}   providers per (media, codec, direction); register/clear/find
  CodecCaps.{h,cpp}      RAM class × instance hints × overrides → per-class limits; stream-vs-caps check
  CodecArbiter.{h,cpp}   resource classes, TryAcquire → Lease (RAII), Snapshot, slotFreed events
  CodecPolicy.{h,cpp}    pure: Resolve(cascade) + Plan(policy, request, catalog, snapshot)
  CodecSelector.h        walks a Plan with a domain "open" callback; returns lease + decision + attempts
  CodecEvents.{h,cpp}    sink installed by JNI / ObjC; JSON payloads

android/src/main/cpp/video/            (existing; becomes a codec-layer client)
  decode/DecoderBackend.h      unchanged interface
  decode/DecoderProviders.{h,cpp}   replaces DecoderFactory.cpp: factory per provider name
  decode/DecoderPool.{h,cpp}   keeps its API; slots carry {backend, lease, decision}; selection + Configure inside AcquireSlot
  decode/FfmpegVideoDecoder.{h,cpp}   (Phase 4, #if HAVE_FFMPEG)
  encode/EncoderProviders.{h,cpp}   replaces EncoderFactory.cpp
  platform/android/AMediaCodecDecoder / Encoder   name per instance (no global name)

android/src/main/cpp/image/
  decode/ImageDecodeBackend.h       (new interface)
  decode/ImageDecoder.*             unchanged portable code, wrapped as the "portable" provider
  platform/android/AImageDecoderBackend.{h,cpp}   (Phase 5)
ios/imagebuffer/ImageIODecodeBackend.{h,mm}       (Phase 5)
ios/videobuffer/VideoToolboxDecoder / Encoder      mode hw | sw (Phase 3)
ios/videobuffer/preview/DecodedSampleBufferRenderer.{h,mm}   (Phase 3)

src/codec/{types.ts,index.ts}       (new public module)
```

`codec/` must not include `video/` or `image/` headers. Domains depend on `codec/`, never the reverse.

### 1.2 Core types (sketch)

```cpp
namespace sherpa_onnx::codec {

enum class Media { Video, Image, Audio };
enum class Direction { Decode, Encode };
enum class Use { Cpu, Display, Export };            // video decode uses; encode is always Export
enum class Tier { Hardware, Software, Unknown };
enum class Origin { Platform, Bundled };
enum class Policy { Hardware, Software, PreferHardware };

enum class Reason {
  None, PoolFull, NotPresent, Disabled, OsTooOld, UnsupportedStream,
  ConfigureFailed, Reclaimed, InvalidSession, SwTooSlow
};

struct StreamCaps {            // what the request needs
  std::string codec;           // "h264", "hevc", "jpeg", "heic", …
  int width = 0, height = 0;
  int profile = -1;            // codec-specific, -1 unknown
  int bitDepth = 8;
  double fps = 0;              // for display real-time checks
  int64_t bitrate = 0;         // logged only (D7)
};

struct ProviderCaps {
  int minW = 0, minH = 0, maxW = 0, maxH = 0;
  int widthAlign = 1, heightAlign = 1;
  int64_t maxBlocks = 0, blockW = 16, blockH = 16;  // 0 = unknown
  std::vector<int> profiles;                        // empty = unknown
  int maxBitDepth = 8;
  int maxInstancesHint = 0;                          // 0 = unknown
  double measuredFps1080Low = 0;                     // 0 = unknown
};

struct Provider {
  Media media; Direction dir; std::string codec;
  Tier tier; Origin origin;
  std::string name;            // "c2.mtk.avc.decoder", "vt.hw", "ffmpeg.h264", "stb", "AImageDecoder"
  ProviderCaps caps;
  bool available = true;
  Reason unavailableReason = Reason::None;   // Disabled / NotPresent / OsTooOld
  int rank = 0;                // order inside (tier, origin)
};

enum class ResourceClass {
  HwVideoDecodeCpu, HwVideoDecodeDisplay, HwVideoEncode,
  SwVideoDecode, SwVideoEncode, PlatformImageDecode
};

struct Attempt { std::string provider; Tier tier; Origin origin; Reason reason; std::string code; };

struct Decision {
  Tier tier = Tier::Unknown; Origin origin = Origin::Platform; std::string provider;
  bool fellBack = false; Reason fallbackReason = Reason::None; std::string fallbackCode;
  std::vector<Attempt> attempts;   // skipped + failed, in order
};

struct Request {
  Media media; Direction dir; Use use; StreamCaps stream;
  Policy policy;               // already resolved through the cascade
  std::string ownerKey;        // buffer id / player id / export op id
};

struct PlanStep { const Provider* provider; ResourceClass resource; };
struct Plan { std::vector<PlanStep> steps; std::vector<Attempt> skipped; };

Plan MakePlan(const Request&, const CodecCatalog&);          // pure, host-tested
}
```

`CodecSelector` is a small template the domains call:

```cpp
template <class Backend>
SelectResult<Backend> Select(const Request& req, CodecArbiter& arb,
    const std::function<Result<std::unique_ptr<Backend>>(const Provider&)>& open);
// for each step: arb.TryAcquire(step.resource, req.ownerKey) → open(provider) (create + Configure)
// first success wins; failures append Attempt; the result keeps the Lease alive with the backend.
```

The error code for an empty result follows findings §8: code of the last attempted step, or the skip reason of the last step if nothing was attempted (`Disabled` → `*_SW_*_DISABLED`).

### 1.3 Plan rules (`MakePlan`)

| Policy | Steps |
| --- | --- |
| `hardware` | HW providers for (media, dir, codec) that pass caps, in rank order |
| `software` | SW platform providers that pass caps, then SW bundled providers that pass caps |
| `preferHardware` | `hardware` steps, then `software` steps |

A provider failing caps → skipped, reason `UnsupportedStream`. An unavailable provider → skipped with its reason. Display use + SW step: skipped with `SwTooSlow` if `measuredFps1080Low` (scaled by area) < 1.2 × stream fps. Unknown perf data → allowed, logged.

### 1.4 Default limits (`CodecCaps`)

HW columns come from the old plan, unchanged. HW caps = `clamp(1..4, min(table, maxInstancesHint))`, ignoring hints ≤ 0 or > 16.

| RAM class | HW decode cpu | HW decode display | HW encode | SW decode | SW encode | platform image |
| --- | --- | --- | --- | --- | --- | --- |
| Low (≤ 3 GB) | 1 | 1 | 1 | 1 | 1 | 1 |
| Mid (≤ 6 GB) | 1 | 1 | 1 | 1 | 1 | 2 |
| High (≤ 12 GB) | 2 | 1 | 1 | 2 | 1 | 2 |
| VeryHigh | 2 | 1 | 2 | 2 | 1 | 2 |

SW decode cap is also bounded by `max(1, hardware_concurrency / 4)`. FFmpeg `thread_count = clamp(cores / 2, 1, 4)`. Overrides through `configureCodecs({ budgets })`, each clamped to 1–4, and reported as `source: 'override'`.

### 1.5 Logs (stable, grep-able)

Logcat tag `SherpaOnnxCodec`; iOS `os_log` with the same prefix. Gated by the existing debug switch.

```
codec.catalog media=video dir=decode codec=h264 provider=c2.android.avc.decoder tier=sw origin=platform max=1920x1088 inst=0 fps1080=47 avail=1
codec.plan owner=vid_off_… use=cpu policy=preferHardware steps=c2.mtk.avc.decoder,c2.android.avc.decoder,ffmpeg.h264 skipped=
codec.try owner=… provider=c2.mtk.avc.decoder resource=hw.dec.cpu
codec.skip owner=… provider=… reason=pool-full inUse=1 max=1
codec.select owner=… provider=c2.android.avc.decoder tier=sw origin=platform fellBack=1 from=VIDEO_DECODER_UNAVAILABLE/pool-full
codec.fail owner=… code=VIDEO_SW_DECODER_DISABLED attempts=…
codec.slot release resource=hw.dec.cpu owner=… inUse=0 max=1
codec.midstream owner=… from=c2.mtk.avc.decoder err=1101 reopen=c2.android.avc.decoder keyUs=…
```

---

## 2. Public API

### 2.1 Types (`src/codec/types.ts`)

```ts
export type CodecPolicy = 'hardware' | 'software' | 'preferHardware';
export type CodecTier = 'hardware' | 'software' | 'unknown';
export type CodecOrigin = 'platform' | 'bundled';
export type CodecUnavailableReason =
  | 'pool-full' | 'not-present' | 'disabled' | 'os-too-old'
  | 'unsupported-stream' | 'configure-failed' | 'reclaimed'
  | 'invalid-session' | 'sw-too-slow';

export type CodecResource =
  | 'hwVideoDecode' | 'hwVideoDisplay' | 'hwVideoEncode'
  | 'swVideoDecode' | 'swVideoEncode' | 'platformImageDecode';

export interface CodecAttempt {
  provider: string; tier: CodecTier; origin: CodecOrigin;
  reason: CodecUnavailableReason; code?: string;
}

export interface CodecDecision {
  tier: CodecTier; origin: CodecOrigin; provider: string;
  fallbackFrom?: { code: string; reason: CodecUnavailableReason };
  attempts?: CodecAttempt[];
}

export interface ConfigureCodecsOptions {
  video?: { decode?: CodecPolicy; display?: CodecPolicy; encode?: CodecPolicy };
  image?: { decode?: CodecPolicy };
  budgets?: Partial<Record<CodecResource, number>>; // 1..4; omit = auto
}

export interface CodecInfo {
  ramClass: 'low' | 'mid' | 'high' | 'veryHigh';
  policies: Required<NonNullable<ConfigureCodecsOptions['video']>> & { imageDecode: CodecPolicy };
  slots: Array<{ resource: CodecResource; max: number; inUse: number; source: 'auto' | 'override' }>;
  providers: Array<{
    media: 'video' | 'image'; direction: 'decode' | 'encode'; codec: string;
    tier: CodecTier; origin: CodecOrigin; provider: string;
    available: boolean; reason?: CodecUnavailableReason;
    maxWidth?: number; maxHeight?: number; maxInstances?: number;
  }>;
}

export type CodecEvent =
  | { type: 'slotFreed'; resource: CodecResource; max: number; inUse: number }
  | { type: 'fallback'; owner: string; use: 'cpu' | 'display' | 'export' | 'image';
      decision: CodecDecision };
```

### 2.2 Functions (`src/codec/index.ts`)

- `configureCodecs(options): Promise<void>`. Validates: policies ∈ the enum, budgets integers 1–4 → otherwise `CODEC_INVALID_ARGUMENT`. Partial updates merge.
- `getCodecInfo(): Promise<CodecInfo>`.
- `subscribeCodecEvents(listener): () => void`. `slotFreed` fires when `inUse` drops, not per frame. `fallback` fires once per (owner, use, from provider, reason), so a 30-file image create on an old Android emits one event, not 30. Per-frame decisions stay readable through frame info.

### 2.3 Per-buffer and per-operation options

| API | New option | Use |
| --- | --- | --- |
| `createOfflineVideoBufferFromFile`, `createEmptyLiveVideoBuffer` | `decodePolicy?` | buffer default for CPU decode |
| `createOfflineImageBufferFromVideo`, `exportVideoFrame` | `decodePolicy?` | CPU decode |
| `exportVideo` | `decodePolicy?`, `encodePolicy?` | input decode, output encode |
| `createVideoPreviewPlayer` | `decodePolicy?` | display |
| `createOfflineImageBufferFromFiles` / `FromBase64`, `createEmptyLiveImageBuffer` | `decodePolicy?` | image decode (lazy `ensure` reuses the buffer's policy) |

Decision reporting:

| Where | Field |
| --- | --- |
| `exportVideo` | returns `ResolvedFileRef & { codecs: { decoder: CodecDecision; encoder: CodecDecision } }` |
| `createOfflineImageBufferFromVideo` | `decoder: CodecDecision` |
| `getVideoBufferInfo` | `decoder?: CodecDecision` (sticky session, if open) |
| Preview snapshot | `decoder?: CodecDecision` |
| `getOfflineImageBufferFrameInfo` | `decoder?: { tier; origin; provider }` |

### 2.4 Errors

New codes: `VIDEO_SW_DECODER_DISABLED`, `VIDEO_SW_ENCODER_DISABLED`, `ERR_IMAGE_SW_DECODER_UNAVAILABLE`, `ERR_IMAGE_HW_DECODER_UNAVAILABLE`, `CODEC_INVALID_ARGUMENT`. Existing codes keep their meaning and gain a reason.

Native result maps add `codecTier`, `codecReason`, `codecAttempts` (JSON). TS keeps throwing `Error("CODE: message")` and additionally sets `code`, `codecTier`, `codecReason`, `codecAttempts` on the error object. That is additive; existing `message.startsWith(code)` checks keep working.

---

## 3. Phases

Each phase is done when the **agent-side checks** pass:

- host C++ tests (`test/cpp`) green, including the new tests of the phase,
- Jest, `tsc` and lint green,
- the phase's smoke items added to §5.1 with exact steps, expected result and the log lines to grep,
- a short note in this file.

Platform-only code (JNI, Kotlin, `.mm`) cannot run on the host. It is kept thin, and its first compile happens in the user's example-app build; build errors reported from there are fixed before the next phase. Device runs and their logcat evidence (stored under `docs/internal/codec/evidence/`) come from the user's smoke runs and never gate a phase.

### Phase 0 — Evidence (no behavior change)

1. `VideoCodecCatalog.kt`: when debug is on, log every video codec per MIME (name, `isHardwareAccelerated` / `isSoftwareOnly` / `isVendor`, size ranges, alignment, block-count, max instances, `getSupportedPerformancePoints`, measured 1080p fps, color formats). Tag `SherpaOnnxCodec`, prefix `codec.catalog.raw`.
2. iOS `VideoToolboxDecoder` / `Encoder`: after session create on iOS 17+/17.4+, read `Using…HardwareAccelerated…` and log `codec.vt decode hw=<0|1>`. No other change. This answers whether today's iOS path is already silently SW (findings #4). Phase 3 implements the tiers either way, so the answer is information, not a dependency.
3. Temporary example **Codec smoke** screen (`example/src/screens/codec-smoke/`, `__DEV__`) for S0–S5. Removed after the 2026-10-31 A142P + iOS Simulator run. Results stay in [hw-sw-codec-smoke-a142p-2026-10-31.md](./hw-sw-codec-smoke-a142p-2026-10-31.md).

Done: logging code + smoke screen skeleton; smoke items S0.1–S0.2 in §5.1.

### Phase 1 — Shared core, slots, fail-fast (absorbs the old plan)

Native:

1. Add `codec/CodecTypes.h`, `CodecLog.h`, `CodecCatalog`, `CodecCaps`, `CodecArbiter`, `CodecPolicy`, `CodecSelector.h`, `CodecEvents`.
2. `DecoderProviders` replaces `DecoderFactory`. `RegisterDecoderFactory(fn)` stays as a test shim that registers one HW/platform provider named `fake`, so existing host tests keep working.
3. `DecoderPool::AcquireSlot(cls, owner, request)` runs `Select`: lease, create, **Configure**. `DecodeSession` accepts a configured backend (skips its lazy `Configure`). CPU timeout becomes 0 (D8). `CloseUnused`, idle close, and the ImageReader drain stay as they are.
4. Encode: `VideoExportSession::Run` acquires `HwVideoEncode` through `Select` and releases on every exit path (including errors after Configure).
5. Caps: init computes limits from the RAM class plus instance hints (Android via the catalog, iOS RAM only).
6. Events: arbiter release → `slotFreed`. JNI `nativeConfigureCodecs`, `nativeGetCodecInfo`; Android event name `SherpaOnnxCodecEvent`; iOS same name through the existing module emitter.
7. Error maps gain `codecReason` (`pool-full` vs `not-present` vs `configure-failed`), the distinction the old plan asked for.

TS: `src/codec/` with `configureCodecs`, `getCodecInfo`, `subscribeCodecEvents`. Policies are parsed and resolved from this phase on. Until a media has a SW provider (video: Phase 2/3, image: Phase 5), `preferHardware` plans contain only HW steps, so behavior equals `hardware`, and the log line says so (`codec.plan … sw=none`). Remove `configureVideoBuffer.decoderBudget` (D9) and update its callers in the example.

Tests (host):

- `test/cpp/codec/codec_plan_test.cpp`: every policy × provider set × caps → steps and skip reasons.
- `codec_arbiter_test.cpp`: fail-fast, RAII release, `slotFreed` once per drop, override clamp.
- `codec_caps_test.cpp`: RAM table, instance hint clamp, implausible hints ignored, block-count / alignment check.
- `decoder_pool_test.cpp`: existing cases + CPU timeout 0.
- `export_session_test.cpp`: second export → `VIDEO_ENCODER_UNAVAILABLE` / `pool-full`, encoder released on error.
- Jest: `configureCodecs` validation, event shape, error fields.

Smoke (user, non-blocking): S1.1–S1.2 in §5.1.

### Phase 2 — Policies + Android platform SW (video)

1. `VideoCodecCatalog.kt` returns **all** AVC/HEVC decoders and encoders with tier (API 29+: `isHardwareAccelerated` / `isSoftwareOnly`; below: the existing name rules), caps, color formats, rank. Passes them to C++ as one JSON (`nativeRegisterVideoCodecs`). Remove `nativeSetHwCodecs` and the global-name statics.
2. `AMediaCodecDecoder(name)` / `AMediaCodecEncoder(name)`: name per instance. Encoder input picks the provider's color format: NV12 (`0x15`) if listed, else I420 (`0x13`) through libyuv `NV12ToI420`. Log the choice.
3. `MediaCodecSurfaceRenderer` gets its provider from the display `Select`. SW codecs render to the Surface the same way.
4. Policy cascade: `VideoEntry` stores the buffer `decodePolicy`. Each open resolves operation > buffer > global > default and logs it. Sticky sessions are keyed by (owner, tier), so a `software` call does not evict a HW sticky session.
5. Wire `decodePolicy` / `encodePolicy` through JNI for every API in §2.3 (video rows). Decisions flow back in result maps.
6. Mid-stream fallback (decode, `preferHardware` only): on `AMEDIACODEC_ERROR_RECLAIMED` or a decode error before the first output frame → drop the session, `Select` again with HW excluded, seek to the last keyframe ≤ target, discard frames below target. Once per session. Emit `fallback`.
7. Docs: findings → this phase's evidence.

Tests (host): plan tests with A142P-shaped catalogs (from the evidence file); mid-stream fallback with `FakeDecoderBackend` returning reclaim on packet N; sticky-per-tier keying.

Defaults until benches B1 / B2 are measured: SW display fallback allowed up to 1080p30 (A142P platform SW measured 47–104 fps at 1080p, findings §3.1), `measuredFps1080Low` = 45 when the OS reports none, SW decode threads = cores / 4 (min 1). Each is one constant in `CodecCaps`, logged at init.

Smoke (user, non-blocking): S2.1–S2.7 in §5.1, benches B1, B2, B3, B6.

### Phase 3 — iOS VideoToolbox tiers

1. `VideoToolboxDecoder(Mode)`: `Hardware` → `RequireHardwareAcceleratedVideoDecoder` on iOS 17+; `Software` → `EnableHardwareAcceleratedVideoDecoder = false`; read `UsingHardwareAcceleratedVideoDecoder` into the decision. iOS < 17: `Hardware` = legacy create, tier `unknown`; `Software` provider unavailable (`os-too-old`). `VTIsHardwareDecodeSupported` is the catalog hint: `vt.hw` decode `available` is false / `not-present` when the OS reports no HW.
2. `VideoToolboxEncoder(Mode)`: same with the 17.4 keys.
3. iOS init registers providers `vt.hw` / `vt.sw` per codec and direction. Decode `vt.hw` availability = OS version **and** `VTIsHardwareDecodeSupported`. Encode `vt.hw` stays advertised when the OS version allows it.
4. Preview: `hardware` keeps `SampleBufferVideoRenderer` (system decode; tier reported `hardware` only when `VTIsHardwareDecodeSupported`, else `unknown`). The SW tier uses the new `DecodedSampleBufferRenderer`: selected `DecoderBackend` → `CVPixelBufferPool` NV12 → `CMSampleBuffer` with PTS → the same layer.
5. `kVTInvalidSessionErr` (background) maps to `invalid-session` and goes through the Phase 2 mid-stream rule.

Tests (host): plan tests with iOS provider sets per OS version (16 → `vt.sw` `os-too-old`, `vt.hw` tier `unknown`; 17.4 → both strict).

Smoke (user, non-blocking): S3.1–S3.3 in §5.1, bench B4.

### Phase 4 — Bundled SW video decoders (opt-in)

1. FFmpeg variant: `build_ffmpeg.sh` / `build_ffmpeg_ios.sh` get `VIDEO_SW_DECODERS=1` → `--enable-decoder=…,h264,hevc --enable-parser=…,h264,hevc`. Same pin (8.1.3-x), same LGPL flags. Artifacts: Maven `com.xdcobra.sherpa:ffmpeg-vsw:<ver>@aar`, iOS release asset `ffmpeg-vsw-ios-<ver>`. Extend [PREBUILT_RESOLUTION.md](../PREBUILT_RESOLUTION.md) with the variant.
2. Switches: Gradle `sherpaOnnxEnableVideoSwDecoders=true` (selects the variant AAR), Podspec `SHERPA_ONNX_ENABLE_VIDEO_SW_DECODERS=1`. No new C define. The provider asks `avcodec_find_decoder` at init and registers `ffmpeg.h264` / `ffmpeg.hevc` as available or `disabled`.
3. `video/decode/FfmpegVideoDecoder.{h,cpp}` (`#if HAVE_FFMPEG`): extradata from `track.codecConfig` (avcC / hvcC, length-prefixed packets as the demuxer emits them), frame threads, `yuv420p` / `yuvj420p` → libyuv `I420ToNV12` into the existing aligned NV12 layout. 10-bit and 4:2:2 / 4:4:4 → `unsupported-stream` in v1. `DecodeSession` lookahead (up to 8 following packets, plus EOS at clip end) covers `FF_THREAD_FRAME` delay and late first AMediaCodec output. No ByteBuffer SW fallback.
4. Register on both platforms with tier software, origin bundled.

Tests (host, real decode with system libav, inside `videobuffer_demux_host_test`): H.264 and HEVC fixtures (MP4 + MKV) → frame count equals the index, PTS monotonic, NV12 checksum stable, `Flush` + seek to keyframe works.

Smoke (user, non-blocking): S4.1–S4.2 in §5.1. B5 (size) is a build measurement, recorded before the variant is published; it does not block the code.

### Phase 5 — ImageBuffer tiers

1. `image/decode/ImageDecodeBackend.h`: `bool Supports(DecodeFormat)`, `DecodeResult Decode(const uint8_t*, size_t, const DecodeOptions&)`. The existing `ImageDecoder` becomes provider `stb` (+ `libwebp` when linked). No code change inside it.
2. Android `AImageDecoderBackend` (API 30+, weak-linked through `__builtin_available(android 30, *)`): `createFromBuffer`, `setTargetSize` when `maxSide` applies (no second `ApplyMaxSide`), `setDataSpace(sRGB)`, RGBA_8888 into an aligned scratch → libyuv `ABGRToRAW` (memory RGBA → RGB) into `RgbFrame`. Formats JPEG / PNG / WebP / GIF / BMP / HEIF.
3. HEIC: API 30+ → `AImageDecoderBackend`; API 28–29 → existing Kotlin hook, registered as platform provider `ImageDecoder.java`; below 28 → unavailable (`os-too-old`). `software` + HEIC → `ERR_IMAGE_SW_DECODER_UNAVAILABLE`.
4. iOS `ImageIODecodeBackend`: `CGImageSourceCreateThumbnailAtIndex` (`…FromImageAlways`, `…WithTransform`, `ThumbnailMaxPixelSize = maxSide`) when scaling, `CreateImageAtIndex` otherwise. Draw once into sRGB RGBA, then libyuv to RGB. Replaces the current HEIC full-decode + two draws.
5. Policy wiring: create (files / base64), lazy `ensure` (buffer policy), live append / ingest. Per-frame decision stored in frame info. `PlatformImageDecode` resource class (D12); with `preferHardware`, pool full → portable.
6. EXIF: verify the platform backends with an EXIF-6 fixture; portable keeps its own rotate.

7. Ranking table: per image format, the order of platform vs portable inside `preferHardware` lives in one table in `CodecCatalog` (default: platform first for every format). A B7/B8 result below 1.5× changes one table entry, logged as `codec.rank`, not the policy.

Tests (host): portable unchanged, libyuv RGBA→RGB byte-order test, plan tests for image catalogs (API 26 / 28 / 30 provider sets, HEIC per tier, ranking table).

Smoke (user, non-blocking): S5.1–S5.4 in §5.1 and benches B7, B8, B9. They are **release** gates (D1): implementation continues without them. If B9 fails (OCR differs), the platform backend gets a debug-first fix (data space, chroma, EXIF). The image default stays `preferHardware`.

### Phase 6 — Image encode tiers (optional, demand-driven)

`AndroidBitmap_compress` (API 30) and `CGImageDestination` as platform encoders for `exportOfflineImageBufferFrame` / `exportVideoFrame`. Main user value: WebP export without libwebp under `preferHardware`. Gate: encode ≥ 1.5× stb on 8MP, or WebP availability.

### Phase 7 — Kotlin buffers after their C++ port

OfflineAudioBuffer registers its FFmpeg audio decoders/encoders as software/bundled providers (no HW tier, by the earlier "HW audio rejected" decision). Effect: `getCodecInfo` lists them, and FFmpeg-off maps through the catalog. No public policy option for audio. Text and segment buffers have no codecs and do not attach.

---

## 4. Benches and gates

Benches B1–B9 were planned against the temporary Codec smoke screen (removed after S0–S5). They remain user-run and do not block. Report p50 / p95, CPU %, and thermal state; Android first, then iOS. Until a bench is run, the defaults named in the phases apply. B5 is the only build-side measurement.

| # | Bench | Platforms | Gate / use |
| --- | --- | --- | --- |
| B1 | Decode throughput HW vs platform SW vs FFmpeg (1, 2, 4 threads): H.264 / HEVC at 360p, 1080p, 4K | A142P + one high-end Android; iPhone | SW display fallback allowed only where sustained fps ≥ 1.2 × stream fps; sets `measuredFps1080Low` defaults when the OS has none |
| B2 | OCR (ppocr, 3 pages) latency while a SW decode runs | A142P | SW decode cap and thread count: OCR p50 regression ≤ 25 % |
| B3 | SW encode 480p / 720p / 1080p (configure success + fps) | A142P | confirms D7 outcome on a real device |
| B4 | VT HW vs SW decode/encode, background behavior | real iPhone (iOS 17+) | Phase 3 gates |
| B5 | Size delta of the `ffmpeg-vsw` variant per ABI and xcframework | build | publish note; no hard gate |
| B6 | Reclaim during export (camera app) | A142P | mid-stream rule works or fails cleanly |
| B7 | `AImageDecoder` full and `setTargetSize` (4096, 1024) **including** the RGB8 copy vs stb + scalar, 24MP JPEG / PNG / WebP | A142P + one high-end Android | ≥ 1.5×; a format below that gets platform rank after portable inside `preferHardware` (logged), not a different policy |
| B8 | ImageIO full and thumbnail vs stb + scalar, 24MP | real iPhone | ≥ 1.5×, same rule as B7 |
| B9 | OCR equivalence: platform vs portable decode on the document fixture set | both | text match ≥ 99 %, box IoU ≥ 0.98; release gate (D1) |

---

## 5. Test matrix

| Layer | Host (CI) | Device |
| --- | --- | --- |
| `codec/` plan, caps, arbiter, events | ✅ full | — |
| Video pool / export with fakes | ✅ | — |
| FFmpeg SW video decode | ✅ real decode (system libav) | ✅ variant on device |
| Android MediaCodec HW / SW | — | ✅ conformance |
| iOS VT HW / SW | `videobuffer_vt_host_test` (macOS VT, not a ranking) | ✅ real iPhone |
| Image portable | ✅ unchanged | ✅ |
| Image platform | — (libyuv conversion only) | ✅ conformance |

Device conformance (S0–S5 recorded 2026-10-31; example screen removed): for each tier available on the device, decode the fixture set (H.264 / HEVC 360p / 1080p / 4K; JPEG EXIF 1 / 6, PNG, WebP, HEIC), compare against the portable or FFmpeg reference (PSNR for video, OCR for images), and dump the catalog. This replaces the host coverage lost on HW and platform paths. Re-runs before a release need a new harness or host/device scripts.

### 5.1 Smoke checklist

Recorded 2026-10-31 in the temporary example screen (now removed). Filter leftover logs with `adb logcat -s SherpaOnnxCodec SherpaOnnx`. "A142P" = the low-end reference device. Example builds keep `ffmpeg-vsw` **on**; S4.2 is the off-flag case. Result column: [hw-sw-codec-smoke-a142p-2026-10-31.md](./hw-sw-codec-smoke-a142p-2026-10-31.md) (A142P 15/0/5, iOS Simulator 11/0/9).

| ID | Device | Steps | Expected | Result |
| --- | --- | --- | --- | --- |
| S0.1 | Android (A142P; plus any Qualcomm / Exynos if available) | Codec smoke → "Dump catalog" | `ffmpeg.*` available when vsw on; platform SW + HW rows; report in `evidence/` | **pass** A142P |
| S0.2 | iOS 17+ | catalog + decode / export | `vt.hw` decode `available` = `VTIsHardwareDecodeSupported` (Simulator: `not-present`); `vt.sw` + encode `vt.hw` present | **pass** Simulator |
| S1.1 | A142P + iOS | two parallel **encodes**, `hwVideoEncode=1`, `encodePolicy: hardware`, `decodePolicy: preferHardware` | one file, one `VIDEO_ENCODER_UNAVAILABLE` / `pool-full`; `slotFreed` after the first finishes | **pass** both |
| S1.2 | A142P + iOS | any decode + export, `preferHardware` | `codec.plan` / `codec.try` / `codec.select` / `codec.slot release`; iOS Simulator lands on `vt.sw` | **pass** both |
| S2.1 | A142P | 1080p H.264, `decodePolicy: 'software'` | platform SW (`OMX.google.h264.decoder` or `c2.android.avc.decoder`) | **pass** `OMX.google.h264.decoder` |
| S2.2 | A142P | 4K HEVC, `software` | vsw on: `ffmpeg.hevc` (same cascade as S4.1). vsw off: `VIDEO_SW_DECODER_DISABLED`, platform SW `unsupported-stream` | **pass** vsw on (`ffmpeg.hevc`) |
| S2.3 | A142P | display budget 1, two previews, default policy | second preview occupies the remaining path; both players stay up | **pass** |
| S2.4 | A142P | export 720p, `encodePolicy: 'software'`, decode `preferHardware` | platform SW encoder; file plays | **pass** |
| S2.5 | A142P | export 1080p, `encodePolicy: 'software'` | `VIDEO_ENCODER_UNAVAILABLE` / `unsupported-stream` (D7) | **pass** |
| S2.6 | A142P | abort mid-export, then recreate | `VIDEO_CANCELLED`; recreate succeeds. Camera reclaim is bench B6 | **pass** abort/recreate |
| S2.7 | A142P (HW present) | decode default vs `hardware` | both HW, same provider. AVD (no HW): default SW + `fallback`; `hardware` → `VIDEO_DECODER_UNAVAILABLE` | **pass** A142P both `OMX.MTK.VIDEO.DECODER.AVC`. AVD unrun |
| S3.1 | iOS 17+ | decode `software` | `vt.sw`, decision `software` | **pass** Simulator |
| S3.2 | iOS 17+ | two HW exports + preview | clean `…_UNAVAILABLE` on the contended HW path, no silent SW. Simulator has no VT HW decode — preview after the exports is enough | **pass** Simulator (preview). Real iPhone unrun |
| S3.3 | iOS | export under `preferHardware`; background if possible | export finishes; background → `invalid-session` + one mid-stream reopen (D6) or clean error | **pass** Simulator (no background in 45s; export ok) |
| S4.1 | Android + iOS, `ffmpeg-vsw` | 4K HEVC `software` | Android: `ffmpeg.hevc` (platform SW HEVC 1080p-capped). iOS: `vt.sw` when platform SW covers 4K; `ffmpeg.hevc` only when it does not | **pass** both |
| S4.2 | same device, **vsw off** | same call | `VIDEO_SW_DECODER_DISABLED`. Example flag on → skip | **skip** (example vsw on) |
| S5.1 | Android API 30+ | JPEG create, default policy | native `AImageDecoder`. Frame JSON `decoder` may be unset (ensure hot-path) | **pass** pixels/size |
| S5.2 | Android API 28 or 29 (emulator is fine) | JPEG + HEIC, default policy | JPEG: `stb` + `fallback` (`os-too-old`); HEIC: `ImageDecoder.java` | unrun (A142P is API 36) |
| S5.3 | Android API 26 (emulator is fine) | HEIC create, default policy | `ERR_IMAGE_SW_DECODER_UNAVAILABLE` | unrun (A142P is API 36) |
| S5.4 | iOS | HEIC + JPEG with `maxSide` | ImageIO; EXIF-6 upright | **pass** Simulator (`heic=256x192`, `jpegExif6=192x256`) |
| Release | A142P + real iPhone | conformance suite + B1–B4, B6–B9 | numbers in §4; B9 must pass before publishing | unrun |

---

## 6. Docs to update (per phase, not up front)

- New public guide `docs/codecs.md`: policies, defaults, cascade, decisions, events, errors, build switches, patent note for the `ffmpeg-vsw` variant.
- `docs/videobuffer-offline.md`: replace "Pixels: HW only" (§Formats) and the out-of-scope line about FFmpeg software video; `configureCodecs` instead of `configureVideoBuffer` budgets; queue recipe on `slotFreed`.
- VideoPreview public doc: display policy and SW preview limits.
- `docs/imagebuffer-offline.md`: image policy, HEIC behavior per tier, WebP without libwebp.
- `docs/disable-ffmpeg.md`: what disabling FFmpeg now also disables (bundled SW video).
- Internal: `videobuffer-internal.md` invariant "HW decode/encode only … excluded" → tiered; `videobuffer-implementation-plan.md` emulator note → resolved by Phase 2; `sdk-feature-support-matrix.md`; [README](../README.md) (done with this plan).

---

## 7. Out of scope

- VP8 / VP9 / AV1 decode or encode (the catalog is codec-agnostic, so it is a later demux + provider addition; Android already ships `c2.android.vp9` / `av1-dav1d`).
- Bundled SW H.264 / HEVC encoders (no acceptable library; findings §3.3).
- Native queueing of promises (fail-fast stays).
- A `preferSoftware` policy (add only with a concrete use case).
- GPU texture / zero-copy surface outputs for OCR.
- Publishing a release before the release smoke row (§5.1) is done. Implementation itself does not wait for it.

---

## 8. Risk register

| Risk | Phase | Mitigation |
| --- | --- | --- |
| Moving `Configure` into acquire changes decode timing / error surfaces | 1 | keep `DecodeSession` API; host tests for configure failure; logcat before/after in smoke S1.2 |
| Sticky-per-tier doubles decoder memory for one buffer | 2 | at most one sticky per tier; idle close unchanged; `CloseUnused` per tier |
| Platform SW color format quirks (flexible YUV layouts) | 2 | log `AImage` plane strides on first frame; PSNR gate vs HW |
| iOS decoded-frame preview drops frames | 3 | only used for the SW tier; stats in snapshot |
| FFmpeg variant drifts from the default pin | 4 | one build script, one pin, variant = extra flags only |
| Weak linking `AImageDecoder` on minSdk 24 | 5 | `__builtin_available` + `-Werror=unguarded-availability`; smoke S5.2 / S5.3 on API 26 / 28 emulators |
| Policy explosion in the API | all | one enum, one cascade, decisions always reported; no per-codec policies |
