# Native diagnostics

SDK-wide **last-activity ring buffer** with **POSIX signal handlers** on Android and iOS. When the process receives `SIGSEGV`, `SIGABRT`, or `SIGBUS`, the buffer is dumped to the platform log before chaining to any previously installed handler (e.g. Firebase Crashlytics).

## Defaults

- **On by default** when `libsherpaonnx` / the SherpaOnnx pod loads (no JS init required).
- Ring buffer records native activity from instrumented paths (`audio.decode`, `stt.detect`, `module.init`, …).
- Opt-out: `configureNativeDiagnostics({ enabled: false })` or `{ installSignalHandler: false }`.

## Platform parity

| Concern | Android | iOS |
|---------|---------|-----|
| Crash dump channel | logcat tag `SherpaNativeDiag` | stderr prefix `SherpaNativeDiag:` + `os_log` subsystem `com.sherpaonnx.diag` |
| Live trail on `Record()` | logcat INFO | `os_log` INFO |
| Signal handler | `sigaction` + chain | same |
| Snapshot API | TurboModule JSON | same |

## Reading logs

**Android**

```bash
adb logcat -s SherpaNativeDiag:*
```

Also scan the main buffer around `Fatal signal` — the diagnostic dump often appears **just before** the RenderThread/GPU stack.

**iOS**

```bash
log stream --predicate 'subsystem == "com.sherpaonnx.diag"'
```

Or Xcode → Devices → Open Console. Look for `SherpaNativeDiag:` on stderr near the crash.

## JS API

```ts
import {
  getNativeDiagnosticSnapshot,
  configureNativeDiagnostics,
} from 'react-native-sherpa-onnx/diagnostics';

const snap = await getNativeDiagnosticSnapshot();
// { enabled, signalHandlerInstalled, entries: [{ seq, domain, phase, threadName, ... }] }

await configureNativeDiagnostics({ installSignalHandler: false }); // opt-out
```

## Domain convention

Use `domain.phase` with short literals, no file paths in `detail`:

- `audio.decode` — `ffmpeg_start`, `open_fail`, `ffmpeg_end`, `guard_open_fail`
- `module.init` — `libs_loaded`
- `stt.detect` — `start`, `end`

## Crashlytics (host app, phase 2)

Call `getNativeDiagnosticSnapshot()` after a non-fatal or on next launch and attach compact fields as custom keys. The signal-handler dump remains the primary tool for **delayed UI-thread crashes** where the tombstone does not show native SDK frames.

## Limitations

- **Mach exceptions** on iOS are not handled in v1 (POSIX signals only).
- `.ips` / Play Console stacks may still show UI/GPU threads; use device logs for the `SherpaNativeDiag` block.
- Handler chaining: init SherpaOnnx before or alongside other crash SDKs; disabling ours: `configureNativeDiagnostics({ installSignalHandler: false })`.

## Privacy

Details are sanitized: no full filesystem paths, only basenames or `key=value` flags.
