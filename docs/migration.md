# Migration Guides

## Breaking changes (upgrading to 0.3.0)

If you are upgrading from an earlier version to **0.3.0**, plan for the following migration steps.

### Instance-based API (TTS + STT)

TTS and STT now use an instance-based factory pattern instead of module-level singletons. Each call to `createTTS()` / `createSTT()` returns an independent engine instance. You **must** call `.destroy()` when done to free native resources.

**TTS Before:**

```ts
initializeTTS({ modelPath: { type: 'asset', path: 'models/vits' } });
const audio = await generateSpeech('Hello');
await unloadTTS();
```

**TTS After:**

```ts
const tts = await createTTS({ modelPath: { type: 'asset', path: 'models/vits' } });
const audio = await tts.generateSpeech('Hello');
await tts.destroy();
```

**STT Before:**

```ts
await initializeSTT({ modelPath: { type: 'asset', path: 'models/whisper' } });
const result = await transcribeFile('/audio.wav');
await unloadSTT();
```

**STT After:**

```ts
const stt = await createSTT({ modelPath: { type: 'asset', path: 'models/whisper' } });
const result = await stt.transcribeFile('/audio.wav');
await stt.destroy();
```

### Speech-to-Text (STT)

- **`transcribeFile`** now returns `Promise<SttRecognitionResult>` (an object with `text`, `tokens`, `timestamps`, `lang`, `emotion`, `event`, `durations`) instead of `Promise<string>`. For text only, use `(await transcribeFile(path)).text`.
- **`initializeSTT`** supports two additional optional options: `hotwordsFile` and `hotwordsScore`. The native TurboModule methods were renamed from `initializeSherpaOnnx` / `unloadSherpaOnnx` to `initializeStt` / `unloadStt`.
- **Removed deprecated type:** `TranscriptionResult` has been removed. Use `SttRecognitionResult` instead (same shape).

### Text-to-Speech (TTS)

- **Instance-based API:** Use `createTTS()` to get a `TtsEngine`; call `tts.generateSpeech()`, `tts.generateSpeechStream()`, etc., then `tts.destroy()`. See [Instance-based API (TTS + STT)](#instance-based-api-tts--stt) above. If you call the **TurboModule directly**, all instance-bound methods now take `instanceId` as the first parameter (see [docs/tts.md – Mapping to Native API](./docs/tts.md#mapping-to-native-api)).
- **TTS model-specific options (breaking for versions &lt; 0.3.0):**  
  Init and update no longer use flat `noiseScale`, `noiseScaleW`, and `lengthScale` on the options object. Use **`modelOptions`** instead, with one block per model type (aligned with the STT `modelOptions` design):
  - **`createTTS` (init):** Replace flat `noiseScale`, `noiseScaleW`, `lengthScale` with `modelOptions`. Only the block for the loaded model type is applied.  
    **Before (old API):** `initializeTTS({ modelPath, modelType: 'vits', noiseScale: 0.667, noiseScaleW: 0.8, lengthScale: 1.0 })`  
    **After:** `createTTS({ modelPath, modelType: 'vits', modelOptions: { vits: { noiseScale: 0.667, noiseScaleW: 0.8, lengthScale: 1.0 } } })`
  - **`tts.updateParams`:** Replace flat `noiseScale` / `noiseScaleW` / `lengthScale` with `modelOptions` (and optionally `modelType`). When `modelType` is omitted, the engine uses the type from `createTTS()`.  
    **Before (old API):** `updateTtsParams({ noiseScale: 0.7, lengthScale: 1.2 })`  
    **After:** `tts.updateParams({ modelOptions: { vits: { noiseScale: 0.7, lengthScale: 1.2 } } })` or `tts.updateParams({ modelType: 'vits', modelOptions: { vits: { ... } } })`
  - Types: `TtsModelOptions`, `TtsVitsModelOptions`, `TtsMatchaModelOptions`, `TtsKokoroModelOptions`, `TtsKittenModelOptions`, `TtsPocketModelOptions` are exported from the TTS module. See [docs/tts.md](./docs/tts.md) for details.
- **Removed deprecated type:** `SynthesisOptions` has been removed. Use `TtsGenerationOptions` instead (same shape).

