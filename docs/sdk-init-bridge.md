# SDK init: public API vs TurboModule bridge

The React Native package uses two layers for engine initialization:

| Layer | Examples | Shape |
|-------|----------|--------|
| **Public** | `createTTS`, `createSTT`, `createStreamingSTT`, `createStreamingVAD`, `createEnhancement`, `createStreamingEnhancement` | Typed, nested options (`TTSInitializeOptions`, `STTInitializeOptions`, `StreamingSttInitOptions`, `VADInitializeOptions`, `EnhancementInitializeOptions`) |
| **Bridge** | `initializeTts`, `initializeStt`, `initializeOnlineStt`, `initializeVad`, `initializeEnhancement`, `initializeOnlineEnhancement` | Flat `ReadableMap` / `NSDictionary` per instance — **not** the primary app API |

## Why two layers?

- **TypeScript** — public unions and JSDoc stay ergonomic for app developers.
- **TurboModule / iOS** — many positional arguments can crash React Native marshalling; a single options object is safe and extensible.
- **Mapping** — dedicated builders flatten nested public fields before calling native code.

## TurboModule init methods (breaking clean cut)

| Bridge method | Public entry | Options type | Builder |
|---------------|--------------|--------------|---------|
| `initializeTts(instanceId, options)` | `createTTS` | `TtsInitBridgeOptions` | `buildTtsInitBridgeOptions` in `src/tts/ttsNativeBridge.ts` |
| `initializeStt(instanceId, options)` | `createSTT` | `SttInitBridgeOptions` | `buildSttInitBridgeOptions` in `src/stt/sttNativeBridge.ts` |
| `initializeOnlineStt(instanceId, options)` | `createStreamingSTT` | `OnlineSttInitBridgeOptions` | `buildStreamingSttInitBridgeOptions` in `src/stt/sttNativeBridge.ts` |
| `initializeVad(instanceId, options)` | `createStreamingVAD` | `VadInitBridgeOptions` | `buildVadInitBridgeOptions` in `src/vad/vadNativeBridge.ts` |
| `initializeEnhancement(instanceId, options)` | `createEnhancement` | `EnhancementInitBridgeOptions` | `buildEnhancementInitBridgeOptions` in `src/enhancement/enhancementNativeBridge.ts` |
| `initializeOnlineEnhancement(instanceId, options)` | `createStreamingEnhancement` | `EnhancementInitBridgeOptions` | `buildEnhancementInitBridgeOptions` in `src/enhancement/enhancementNativeBridge.ts` |

Bridge option types are defined in `src/NativeSherpaOnnx.ts` (required for React Native codegen) and re-exported from `src/nativeBridge/initBridgeTypes.ts` for builders.

There is **no** legacy positional overload and **no** `*WithOptions` suffix on the TurboModule names.

## Mapping examples

**TTS — Kokoro init lang (bridge-only key):**

```ts
// Public
createTTS({
  modelType: 'kokoro',
  modelOptions: { kokoro: { lang: 'us-en' } },
});

// Bridge map (internal)
{ modelDir, modelType: 'kokoro', kokoroLang: 'us-en' }
```

**STT — nested model options:**

```ts
// Public
createSTT({
  modelType: 'whisper',
  modelOptions: { whisper: { language: 'en', task: 'transcribe' } },
});

// Bridge map (internal) — modelOptions passed as nested map
{ modelDir, modelType: 'whisper', modelOptions: { whisper: { language: 'en', task: 'transcribe' } } }
```

**Streaming STT — endpoint rules flattened:**

```ts
// Public
createStreamingSTT({
  endpointConfig: { rule1: { minTrailingSilence: 2.4, ... } },
});

// Bridge map (internal)
{ modelDir, modelType, rule1MinTrailingSilence: 2.4, ... }
```

**TTS — custom init:**

```ts
// Public
createTTS({
  initMode: 'custom',
  modelType: 'vits',
  customConfig: {
    ttsModel: { kind: 'fs', path: '/models/en.onnx' },
    tokens: { kind: 'fs', path: '/models/tokens.txt' },
  },
});

// Bridge map (internal)
{ initMode: 'custom', modelType: 'vits', modelPaths: { ttsModel: '...', tokens: '...' } }
```

**VAD — custom init:**

```ts
// Public
createStreamingVAD({
  initMode: 'custom',
  modelType: 'silero_vad',
  customConfig: {
    model: { kind: 'fs', path: '/models/silero_vad.onnx' },
  },
});

// Bridge map (internal) — buildVadInitBridgeOptions
{ initMode: 'custom', modelType: 'silero_vad', modelPaths: { model: '...' } }
```

**Enhancement — custom init (offline and streaming share one builder):**

```ts
// Public
createEnhancement({
  initMode: 'custom',
  modelType: 'gtcrn',
  customConfig: {
    model: { kind: 'fs', path: '/models/gtcrn.onnx' },
  },
});

// Bridge map (internal) — buildEnhancementInitBridgeOptions
{ initMode: 'custom', modelType: 'gtcrn', modelPaths: { model: '...' } }
```

`createStreamingEnhancement` uses the same public union and `initializeOnlineEnhancement` with the same bridge shape.

Bridge fields for TTS init:

| Public | Bridge key | Notes |
|--------|------------|--------|
| `initMode: 'custom'` | `initMode`, `modelPaths`, `modelType` | No `modelDir` |
| `initMode: 'auto'` (default) | `initMode`, `modelDir`, `modelType` | No `modelPaths` |
| `modelOptions.kokoro.lang` | `kokoroLang` | Bridge-only |
| `lexiconLanguageId` | `lexiconLanguageId` | Auto mode only |

Bridge fields for VAD init:

| Public | Bridge key | Notes |
|--------|------------|--------|
| `initMode: 'custom'` | `initMode`, `modelPaths`, `modelType` | No `modelDir`; single key `model` |
| `initMode: 'auto'` (default) | `initMode`, `modelDir`, `modelType` | No `modelPaths` |
| `runtimeOptions.*` | `threshold`, `silenceDurationMs`, `speechDurationMs`, `minSpeechDurationMs`, `maxSpeechDurationS`, `windowSize` | Flattened scalars |

Bridge fields for Enhancement init:

| Public | Bridge key | Notes |
|--------|------------|--------|
| `initMode: 'custom'` | `initMode`, `modelPaths`, `modelType` | No `modelDir`; single key `model` |
| `initMode: 'auto'` (default) | `initMode`, `modelDir`, `modelType` | No `modelPaths` |
| `numThreads`, `provider`, `debug` | same names | Scalars on both modes |

**Positional → options migration:** `initializeEnhancement` and `initializeOnlineEnhancement` previously accepted positional `(instanceId, modelDir, modelType?, …)` arguments. They now take `(instanceId, options: EnhancementInitBridgeOptions)` only. App code should use `createEnhancement` / `createStreamingEnhancement`; direct TurboModule callers must pass an options map.

## TTS language fields (bridge)

| Public | Bridge key | Notes |
|--------|------------|--------|
| `lexiconLanguageId` | `lexiconLanguageId` | Same name |
| `modelOptions.kokoro.lang` | `kokoroLang` | Bridge-only; do not use in app code |
| `synthesize({ lang })` | `lang` on synthesis map | Runtime; effective for kokoro + supertonic |

## Codegen

After changing `src/NativeSherpaOnnx.ts`, run React Native codegen so Android `NativeSherpaOnnxSpec` and iOS `SherpaOnnxSpec` stubs stay in sync:

```bash
yarn react-native codegen
```
