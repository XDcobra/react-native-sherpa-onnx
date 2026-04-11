# TextBuffer-Pipeline — Spezifikation (STT + zukünftiges TTS)

Dieses Dokument beschreibt das **Zielbild** und die **Anforderungen** für **native TextBuffer** (Offline + Live), analog zur bestehenden **AudioBuffer**-Pipeline, sowie die **Entfernung** der bisherigen STT-Text-Ergebnis-API.

**Nicht im Umfang dieser Spec:** konkrete TTS-Code-Änderungen — TTS dient nur als **Orientierung**, dass künftig **TextBuffer** als Eingabe dienen können.

---

## Ziele

1. **Alte STT-Text-Logik vollständig entfernen**  
   Keine `getSttResultText` / `getSttResultTokens` / `getSttResultTimestamps` / `getSttResultDurations` / `getSttResultLang` / `getSttResultEmotion` / `getSttResultEvent` / `releaseSttResult` mehr auf Basis einer **`resultId`** (und kein paralleles „Legacy nebenbei“).

2. **TextBuffer analog zu AudioBuffer**  
   Zwei Kind-Typen mit klarer Semantik:
   - **OfflineTextBuffer** — immutable, vollständig gefüllter Text (und ggf. assoziierte strukturierte Felder: Tokens, Zeiten, … je nach Modell), **native** Registry mit stabilen IDs (z. B. Präfix `txt_off_…` o. Ä. — endgültiges Präfix in der Implementierung festlegen, konsistent Android/iOS).
   - **LiveTextBuffer** — inkrementell, **recording → finished** (analog [`LiveAudioBuffer`](../../../src/audiobuffer/types.ts)), Partial-Updates, Callbacks.

3. **Pipeline-Integration**  
   - **STT** schreibt das Erkennungsergebnis **in einen vorgegebenen TextBuffer** (Ausgabe-Ziel), statt ein anonymes „Result-Slot + resultId“-Modell.  
   - **Zukünftiges TTS** konsumiert **TextBuffer** als Eingabe (gleiche mentale API wie „Audio rein / Text rein“) — **keine** TTS-Implementierung in diesem Schritt.

4. **Konvertierung Live ↔ Offline (Text)**  
   - **LiveTextBuffer → OfflineTextBuffer** (z. B. nach Finalisierung oder Snapshot des aktuellen Fensters) — analog [`createOfflineAudioBufferFromLive`](../../../src/audiobuffer/index.ts) mit Modi (`fullIfSpooled`-Äquivalent / `windowSnapshot`-Äquivalent, Semantik textspezifisch definieren).  
   - **OfflineTextBuffer → LiveTextBuffer** wo sinnvoll (z. B. Seeding eines Live-Buffers für iterative Bearbeitung / UI-Stream) — API und Nutzen explizit dokumentieren.

5. **TypeScript so strikt wie möglich**  
   - Branded Handles (`OfflineTextBufferHandle`, `LiveTextBufferHandleRecording`, `LiveTextBufferHandleFinished`, …).  
   - **`OfflineTextBufferRef`** / **`LiveTextBufferRef`** als typisierte Rückgaben der `create*`-Funktionen (analog [`OfflineAudioBufferRef`](../../../src/audiobuffer/types.ts) / [`LiveAudioBufferRef`](../../../src/audiobuffer/types.ts)).  
   - Öffentlicher Export z. B. `react-native-sherpa-onnx/textbuffer` (Pfadname final wie bei `audiobuffer`).

6. **Vollständig native, metadata-first**  
   Wie bei Audio: Registry und Nutzdaten liegen **native**; nach außen zunächst **Metadaten** (Länge, Zählungen, Flags, …). **Schwere Nutzlast** (vollständiger String, Token-Arrays, …) nur über explizite **Getter**-Aufrufe in den JS-Facades (Chunking / Slices wo nötig, Limits dokumentieren).

7. **LiveTextBuffer mit Callback**  
   Analog Live-Audio: optional **Events** oder **Callback** bei neuem Partial-Text / Append (producer-agnostisch wo möglich), plus **Fehlerpfad**; Konfiguration (Throttle, Min-Intervall) analog zu [`CreateLiveAudioBufferOptions`](../../../src/audiobuffer/types.ts) wo sinnvoll.

---

## Nicht-Ziele (explizit)

- **Keine** Änderungen am **TTS**-Modul in diesem Arbeitspaket (nur Planungsanker: TTS wird später **TextBuffer** als Input akzeptieren).
- Keine Rückwärtskompatibilität zu `resultId`-Gettern.

---

## STT: neues Verhalten (skizzenhaft)

- Vor **Transkription**: Host erzeugt **OfflineTextBuffer** (leer / vorbereitet) und **OfflineAudioBuffer** (Eingabe).  
- **`transcribe`** (Name final): erhält Referenzen auf **Audio-Eingabe** + **Text-Ausgabe-Ziel** (Handles oder `*Ref`-Objekte — gleiche Konvention wie bei Audio).  
- Native STT-Schicht führt Erkennung aus und **materialisiert** Ergebnis **in den TextBuffer** (ein Schreibvorgang pro Transkription für Offline; bei Streaming später inkrementell in **LiveTextBuffer**).

**Streaming-STT (Online):** in derselben Spec oder Folge-Spec festhalten, dass Partial-Ergebnisse in **LiveTextBuffer** geschrieben werden und Callbacks feuern — Umsetzung kann nach Offline-Pfad erfolgen.

---

## Native Schicht (Orientierung)

- Eigenes Paket / Registry (Kotlin: z. B. parallel zu [`PipelineAudioRegistry`](../../../android/src/main/java/com/sherpaonnx/audio/pipeline/PipelineAudioRegistry.kt); iOS: analog zu Pipeline-Audio-Maps).  
- Einheitliche **Fehlercodes** (nicht gefunden, falscher Typ, leer, invalid state, …).  
- **TurboModule**-Methoden: `createOfflineTextBuffer…`, `createLiveTextBuffer…`, `finalizeLiveTextBuffer`, `createOfflineTextBufferFromLive`, ggf. `createLiveTextBufferFromOffline`, `getPipelineTextBufferInfo`, `releasePipelineTextBuffer`, Getter für Inhalte (Slices), Live-Subscribe analog.

---

## Konvertierung Live ↔ Offline (Text)

| Richtung | Zweck (analog Audio) |
| --- | --- |
| **Live → Offline** | Finales oder bestes Snapshot eines Partial-Streams als immutable Offline-Text für Downstream (Alignment, Export, TTS). |
| **Offline → Live** | Optional: Start eines bearbeitbaren / streambaren Textfensters aus festem Text. |

Modi und Grenzfälle (leer, noch nicht finalisiert) **native** validieren mit klaren Fehlern.

---

## TypeScript-Öffentlichkeit

- Modul **`react-native-sherpa-onnx/textbuffer`**: dünne Facades, keine Geschäftslogik in JS.  
- Typen: Handles, `*Ref`, Info-Discriminated-Unions (`kind`, `state` für Live).  
- `transcribe`-Signatur in [`stt`](../../../src/stt/index.ts): nach Migration nur noch Pipeline-Handles inkl. **TextBuffer-Ziel**.

---

## TypeScript-Signaturen (konkret, Zielzustand)

Die folgenden Typen und Signaturen sind die **öffentliche TS-Ziel-API** (analog [`src/audiobuffer/types.ts`](../../../src/audiobuffer/types.ts)). Native IDs z. B. `txt_off_…` / `txt_live_…` — **Präfix final bei Implementierung** festlegen, konsistent Android/iOS.

### Arten und Zustände

```typescript
/** Pipeline-Textbuffer-Discriminator (Info.kind). */
export type PipelineTextBufferKind = 'offlineTextBuffer' | 'liveTextBuffer';

/** Offline-Text ist nach Befüllung immutable (wie Offline-Audio). */
export type OfflineTextBufferState = 'immutable';

/** Live-Text: recording → finished (kein Rückweg). */
export type LiveTextBufferState = 'recording' | 'finished';
```

### Branded Handles

```typescript
export type OfflineTextBufferHandle = string & {
  readonly __brand: 'OfflineTextBufferHandle';
};

export type LiveTextBufferHandleRecording = string & {
  readonly __brand: 'LiveTextBufferHandleRecording';
};

export type LiveTextBufferHandleFinished = string & {
  readonly __brand: 'LiveTextBufferHandleFinished';
};

export type LiveTextBufferHandle =
  | LiveTextBufferHandleRecording
  | LiveTextBufferHandleFinished;

export type PipelineTextBufferHandle =
  | OfflineTextBufferHandle
  | LiveTextBufferHandle;
```

### Metadaten (native `getInfo`, keine schwere Nutzlast)

```typescript
/** Metadaten für einen Offline-Textbuffer (nach STT-Befüllung o. Ä.). */
export interface OfflineTextBufferInfo {
  bufferId: string;
  kind: 'offlineTextBuffer';
  state: OfflineTextBufferState;
  /** UTF-16-Länge des gesamten Hypothesen-Strings. */
  utf16Length: number;
  tokenCount: number;
  timestampCount: number;
  durationCount: number;
  hasLang: boolean;
  hasEmotion: boolean;
  hasEvent: boolean;
}

/**
 * Metadaten für einen Live-Textbuffer (Streaming-STT, inkrementell).
 * Zähler sind native definiert (analog totalSamplesWritten bei Live-Audio).
 */
export interface LiveTextBufferInfo {
  bufferId: string;
  kind: 'liveTextBuffer';
  state: LiveTextBufferState;
  /** Monoton: angenommene UTF-16-Einheiten (inkl. Rewrites, falls Modell komplett ersetzt). */
  totalCharsWritten: number;
  /** Optional: Generation/Revision für Partial-Events (native Coalescing). */
  revision: number;
}

export type PipelineTextBufferInfo = OfflineTextBufferInfo | LiveTextBufferInfo;
```

### `*Ref` (Rückgaben der `create*`-Hilfen, analog Audio)

```typescript
export interface OfflineTextBufferRef {
  info: OfflineTextBufferInfo;
  bufferId: OfflineTextBufferHandle;
}

export interface LiveTextBufferRef {
  info: LiveTextBufferInfo;
  bufferId: LiveTextBufferHandleRecording;
  unsubscribeEvents: () => void;
}
```

### Live-Callbacks (analog Live-Audio)

```typescript
/** Quelle eines Partial-Updates (native kann aggregieren). */
export type LiveTextBufferPartialSource =
  | 'stt_stream'
  | 'append'
  | 'replace'
  | 'unknown'
  | 'mixed';

export interface LiveTextBufferPartialEvent {
  liveBufferId: string;
  source: LiveTextBufferPartialSource;
  /** Hypothese für dieses Event (vollständiger Partial-String dieser Runde). */
  partialText: string;
  revision: number;
  /** Optional: Endpoint vom Online-Recognizer. */
  isEndpoint?: boolean;
}

export interface LiveTextBufferErrorEvent {
  liveBufferId?: string;
  message: string;
}

export interface LiveTextBufferCallbacks {
  onPartial?: (event: LiveTextBufferPartialEvent) => void;
  onError?: (event: LiveTextBufferErrorEvent) => void;
}

/** Optionen für `createLiveTextBuffer` (analog CreateLiveAudioBufferOptions). */
export interface CreateLiveTextBufferOptions {
  /**
   * Optionales Fenster: max. gehaltene UTF-16-Zeichen für Partial-Historie (Ring).
   * Default: native/SDK.
   */
  windowMaxChars?: number;
  emitPartialEvents?: boolean;
  partialEventMinIntervalMs?: number;
  onPartial?: (event: LiveTextBufferPartialEvent) => void;
  onError?: (event: LiveTextBufferErrorEvent) => void;
}
```

### Konvertierung Live ↔ Offline (Text)

```typescript
/** Analog OfflineFromLiveMode bei Audio. */
export type OfflineTextBufferFromLiveMode = 'fullIfSpooled' | 'windowSnapshot';
```

### Facades (`textbuffer`-Modul, Ziel)

```typescript
// —— Offline ——

/** Leerer Offline-Textbuffer als Ausgabe-Ziel für Offline-STT (native allokiert). */
export declare function createEmptyOfflineTextBuffer(options?: {
  /** Optional: Reservierung für Token-/Zeitachsen-Slots (Implementation). */
  reservedCounts?: {
    maxTokens?: number;
    maxTimestamps?: number;
    maxDurations?: number;
  };
}): Promise<OfflineTextBufferRef>;

/** Live → Offline (Snapshot / finales Spool-Äquivalent). */
export declare function createOfflineTextBufferFromLive(
  liveBufferId: LiveTextBufferHandle,
  mode?: OfflineTextBufferFromLiveMode
): Promise<OfflineTextBufferRef>;

// —— Live ——

export declare function createLiveTextBuffer(
  options: CreateLiveTextBufferOptions
): Promise<LiveTextBufferRef>;

/** Offline-Text in einen Live-Buffer übernehmen (optional, für UI-Stream / Editing). */
export declare function createLiveTextBufferFromOffline(
  offlineBufferId: OfflineTextBufferHandle
): Promise<LiveTextBufferRef>;

export declare function finalizeLiveTextBuffer(
  liveBufferId: LiveTextBufferHandleRecording
): Promise<LiveTextBufferHandleFinished>;

// —— Info / Release ——

export declare function getPipelineTextBufferInfo(
  bufferId: PipelineTextBufferHandle | string
): Promise<PipelineTextBufferInfo>;

export declare function releasePipelineTextBuffer(
  bufferId: PipelineTextBufferHandle | string
): Promise<void>;

// —— Getter (schwere Nutzlast, Slices) ——

export declare function getOfflineTextBufferTextSlice(
  bufferId: OfflineTextBufferHandle,
  startUtf16: number,
  maxUtf16: number
): Promise<string>;

export declare function getOfflineTextBufferTokensSlice(
  bufferId: OfflineTextBufferHandle,
  start: number,
  maxCount: number
): Promise<string[]>;

export declare function getOfflineTextBufferTimestampsSlice(
  bufferId: OfflineTextBufferHandle,
  start: number,
  maxCount: number
): Promise<number[]>;

export declare function getOfflineTextBufferDurationsSlice(
  bufferId: OfflineTextBufferHandle,
  start: number,
  maxCount: number
): Promise<number[]>;

export declare function getOfflineTextBufferLang(
  bufferId: OfflineTextBufferHandle
): Promise<string>;

export declare function getOfflineTextBufferEmotion(
  bufferId: OfflineTextBufferHandle
): Promise<string>;

export declare function getOfflineTextBufferEvent(
  bufferId: OfflineTextBufferHandle
): Promise<string>;

/** Optional: Partial-String aus Live-Buffer (Debug/UI), nicht der Kanon für finales Offline. */
export declare function getLiveTextBufferPartialSlice(
  liveBufferId: LiveTextBufferHandle,
  startUtf16: number,
  maxUtf16: number
): Promise<string>;
```

### STT-Engine (`stt`-Modul, Ziel nach Migration)

Audio-Typen kommen aus **`react-native-sherpa-onnx/audiobuffer`** (`OfflineAudioBufferRef`, `OfflineBufferHandle`); Text aus **`textbuffer`**.

```typescript
import type { OfflineAudioBufferRef, OfflineBufferHandle } from 'react-native-sherpa-onnx/audiobuffer';
import type { OfflineTextBufferRef, OfflineTextBufferHandle } from 'react-native-sherpa-onnx/textbuffer';

export interface SttEngine {
  readonly instanceId: string;

  /**
   * Offline-STT: liest Audio-Offline-Buffer, schreibt Ergebnis in den vorgegebenen Offline-Textbuffer.
   * Kein resultId-Rückgabewert — Erfolg/Fehler per Promise; Inhalt über Textbuffer-Getter.
   */
  transcribe(
    audio: OfflineAudioBufferRef | OfflineBufferHandle | string,
    textOut: OfflineTextBufferRef | OfflineTextBufferHandle
  ): Promise<void>;

  setConfig(options: SttRuntimeConfig): Promise<void>;
  destroy(): Promise<void>;
}
```

**Hinweis:** Streaming-STT nutzt später zusätzlich **`LiveTextBufferRef`** / **`LiveTextBufferHandleRecording`** als `textOut` — Signatur kann zu einer Überladung oder einem Options-Objekt erweitert werden (`{ audio, textOut, mode: 'offline' | 'live' }`), sobald Live implementiert ist.

---

## Entfernen (Checkliste alte STT-Text-API)

Zu streichen bzw. zu ersetzen (inkl. TurboModule + Codegen + nativen Pfaden), sobald TextBuffer produktiv ist:

- `getSttResultText`, `getSttResultTokens`, `getSttResultTimestamps`, `getSttResultDurations`, `getSttResultLang`, `getSttResultEmotion`, `getSttResultEvent`, `releaseSttResult`  
- Internes **Result-Slot-Modell**, sofern vollständig durch **TextBuffer-Schreibzugriff** ersetzt (oder Slot nur noch intern unsichtbar hinter TextBuffer-Implementierung).

Dokumentation: [`docs/stt-offline.md`](../../stt-offline.md) und Migration unter [`docs/migration/stt/`](../stt/) anpassen, wenn die Implementierung erfolgt.

---

## Phasen (empfohlen)

1. **Spec + ID-Präfixe + Fehlercodes** finalisieren (dieses Dokument verfeinern).  
2. **Native** Offline-TextBuffer + Registry + TurboModule + **iOS-Parität**.  
3. **TS** `textbuffer`-Export + typisierte Facades + Getter-Slices.  
4. **STT Offline**: `transcribe` auf Audio + **OfflineTextBuffer** umstellen; alte Getter entfernen.  
5. **LiveTextBuffer** + Callbacks + **Finalize** + **Live↔Offline** Konvertierung.  
6. **Streaming-STT** an LiveTextBuffer anbinden (Folge-Epic).  
7. **Tests** (State-Machine, Konvertierung, große Texte / Slice-Limits).

---

## Erfolgskriterien

- Keine öffentliche STT-API mehr, die **Ergebnisdaten** über **`resultId`**-Getter liefert.  
- Text lebt in **Pipeline-TextBuffern**; JS sieht primär **Metadaten**, Inhalt über **Getter**.  
- Live- und Offline-TextBuffer sind **native**, **typisiert** in TS, und **konvertierbar** (Live ↔ Offline) mit dokumentierter Semantik.  
- Audio- und Text-Pipeline folgen **demselben mentalen Modell** (Handle, Ref, Release, optional Live-Events).

---

## Verweise

- Audio-Pipeline / Typen: [`src/audiobuffer/types.ts`](../../../src/audiobuffer/types.ts), [`src/audiobuffer/index.ts`](../../../src/audiobuffer/index.ts)  
- STT-Puffer-Zielbild: [stt-pipeline-buffer-only-api-plan.md](../stt/stt-pipeline-buffer-only-api-plan.md)  
- Audio-Pipeline-Architektur: [audio_pipeline_buffers_7605bf7f.plan.md](../audio_pipeline_buffers_7605bf7f.plan.md)
