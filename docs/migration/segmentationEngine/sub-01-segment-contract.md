# Sub-Plan 01: Segment Contract & Types

## Status
- Phase 1a (High-Level Scope): Completed
- Runtime follow-up (LinkMap APIs/logic/tests): Implemented
- Prerequisite for: Sub-Plan 02, 03, 04, 05

## Purpose

Define the canonical segment data model and cross-domain linkage model that is shared across text and audio domains, all pipeline modes (offline/streaming), and all features. This is the foundational type system on which everything else builds.

Two core artifacts:
- **Segment** = boundary within a single domain (`text` or `speech`)
- **SegmentLink** = relationship *between* domains (text ↔ speech)

---

## Design Principles

1. **One contract, two domains:** Text and speech segments share a common base with domain-specific extensions.
2. **Native-first:** Types are defined natively (Kotlin sealed classes / C++ structs). TypeScript types are derived projections.
3. **Immutable after commit:** Once a segment is committed, its fields do not change.
4. **IDs are globally unique:** Each segment gets a UUID at creation. No reuse, no collision.
5. **Cross-domain linkage is a core artifact:** `SegmentLink` is domain-agnostic and feature-agnostic. It is defined alongside Segment, not as a feature-specific add-on. Any feature that produces relationships between text and speech segments uses this one type.

---

## TypeScript Type Definitions

### Base Segment

```typescript
/**
 * Common fields shared by all segments, regardless of domain.
 */
interface SegmentBase {
  /** Globally unique segment identifier */
  segmentId: string;

  /** Domain discriminator */
  domain: 'text' | 'speech';

  /** Start offset in domain-specific units (UTF-16 index or sample index) */
  startOffset: number;

  /** End offset in domain-specific units (exclusive) */
  endOffset: number;

  /** Why this segment boundary was created */
  reason: SegmentReason;

  /** What entity created this segment */
  source: SegmentSource;

  /** Timestamp of segment creation (epoch ms) */
  createdAtMs: number;

  /** Monotonic segment index within this buffer (0-based, never reset) */
  segmentIndex: number;
}
```

### Reason and Source Enums

```typescript
type SegmentReason =
  | 'endpoint'            // STT endpoint / silence detection
  | 'punctuation'         // punctuation-based boundary
  | 'length_limit'        // max-length policy triggered
  | 'vad_boundary'        // VAD speech boundary
  | 'energy_silence'      // energy/silence threshold
  | 'manual_commit'       // explicit commit() call
  | 'finalize'            // buffer finalization triggered final segment
  | 'policy_checkpoint';  // coarse checkpoint from continuous policy

type SegmentSource =
  | 'segmentation_engine'  // engine auto-segmented
  | 'manual'               // API/user manual commit
  | 'external';            // future: from external segment buffer
```

### Text Segment

```typescript
/**
 * A committed text segment.
 */
interface TextSegment extends SegmentBase {
  domain: 'text';

  /** The committed text content for this segment */
  text: string;

  /** UTF-16 length of the text */
  utf16Length: number;

  /** Optional token-level breakdown */
  tokens?: string[];

  /** Optional per-token timestamps (seconds) */
  timestamps?: number[];

  /** Optional detected language */
  lang?: string;

  /**
   * Opaque metadata for feature-specific data.
   * Features like TTS attach sid, speed, etc.
   */
  meta?: Record<string, unknown>;
}
```

### Speech Segment

```typescript
/**
 * A committed speech/audio segment.
 */
interface SpeechSegment extends SegmentBase {
  domain: 'speech';

  /** ID of the audio buffer this segment references */
  sourceAudioBufferId: string;

  /** Sample rate of the referenced audio */
  sampleRate: number;

  /** Duration of this segment in milliseconds */
  durationMs: number;

  /** Optional confidence score (0.0–1.0) */
  confidence?: number;

  /** Optional average energy level (dB) */
  energy?: number;

  /** Optional VAD-specific metadata */
  vadInfo?: {
    engine?: string;
    decision?: string;
    score?: number;
  };

  /**
   * Opaque metadata for feature-specific data.
   */
  meta?: Record<string, unknown>;
}
```

### Discriminated Union

```typescript
/** The canonical segment type */
type Segment = TextSegment | SpeechSegment;

/** Type guard */
function isTextSegment(seg: Segment): seg is TextSegment {
  return seg.domain === 'text';
}

function isSpeechSegment(seg: Segment): seg is SpeechSegment {
  return seg.domain === 'speech';
}
```

---

## Native Type Mapping

### Kotlin (Android)

```kotlin
sealed interface Segment {
    val segmentId: String
    val domain: SegmentDomain
    val startOffset: Long
    val endOffset: Long
    val reason: SegmentReason
    val source: SegmentSource
    val createdAtMs: Long
    val segmentIndex: Int
}

enum class SegmentDomain { TEXT, SPEECH }

enum class SegmentReason {
    ENDPOINT,
    PUNCTUATION,
    LENGTH_LIMIT,
    VAD_BOUNDARY,
    ENERGY_SILENCE,
    MANUAL_COMMIT,
    FINALIZE,
    POLICY_CHECKPOINT
}

enum class SegmentSource {
    SEGMENTATION_ENGINE,
    MANUAL,
    EXTERNAL
}

data class TextSegment(
    override val segmentId: String,
    override val startOffset: Long,      // UTF-16 index
    override val endOffset: Long,        // UTF-16 index (exclusive)
    override val reason: SegmentReason,
    override val source: SegmentSource,
    override val createdAtMs: Long,
    override val segmentIndex: Int,
    val text: String,
    val utf16Length: Int,
    val tokens: List<String>? = null,
    val timestamps: FloatArray? = null,
    val lang: String? = null,
    val meta: Map<String, Any?>? = null
) : Segment {
    override val domain = SegmentDomain.TEXT
}

data class SpeechSegment(
    override val segmentId: String,
    override val startOffset: Long,      // sample index
    override val endOffset: Long,        // sample index (exclusive)
    override val reason: SegmentReason,
    override val source: SegmentSource,
    override val createdAtMs: Long,
    override val segmentIndex: Int,
    val sourceAudioBufferId: String,
    val sampleRate: Int,
    val durationMs: Float,
    val confidence: Float? = null,
    val energy: Float? = null,
    val vadInfo: VadInfo? = null,
    val meta: Map<String, Any?>? = null
) : Segment {
    override val domain = SegmentDomain.SPEECH
}

data class VadInfo(
    val engine: String? = null,
    val decision: String? = null,
    val score: Float? = null
)
```

### C++ (iOS)

```cpp
enum class PaSegmentDomain : uint8_t { Text, Speech };

enum class PaSegmentReason : uint8_t {
    Endpoint,
    Punctuation,
    LengthLimit,
    VadBoundary,
    EnergySilence,
    ManualCommit,
    Finalize,
    PolicyCheckpoint
};

enum class PaSegmentSource : uint8_t {
    SegmentationEngine,
    Manual,
    External
};

struct PaSegmentBase {
    std::string segmentId;
    PaSegmentDomain domain;
    int64_t startOffset;
    int64_t endOffset;
    PaSegmentReason reason;
    PaSegmentSource source;
    int64_t createdAtMs;
    int32_t segmentIndex;
};

struct PaTextSegment : PaSegmentBase {
    // domain = PaSegmentDomain::Text
    std::string text;
    int32_t utf16Length;
    std::optional<std::vector<std::string>> tokens;
    std::optional<std::vector<float>> timestamps;
    std::optional<std::string> lang;
    // meta serialized as JSON string for bridge compatibility
    std::optional<std::string> metaJson;
};

struct PaSpeechSegment : PaSegmentBase {
    // domain = PaSegmentDomain::Speech
    std::string sourceAudioBufferId;
    int32_t sampleRate;
    float durationMs;
    std::optional<float> confidence;
    std::optional<float> energy;
    std::optional<PaVadInfo> vadInfo;
    std::optional<std::string> metaJson;
};

struct PaVadInfo {
    std::optional<std::string> engine;
    std::optional<std::string> decision;
    std::optional<float> score;
};

// Variant
using PaSegment = std::variant<PaTextSegment, PaSpeechSegment>;
```

---

## Serialization for Bridge

Segments cross the native → JS bridge as JSON objects. The serialization format matches the TypeScript types directly:

```json
{
  "segmentId": "seg_a1b2c3",
  "domain": "text",
  "startOffset": 0,
  "endOffset": 42,
  "reason": "punctuation",
  "source": "segmentation_engine",
  "createdAtMs": 1714234567890,
  "segmentIndex": 0,
  "text": "Hello world.",
  "utf16Length": 12,
  "tokens": ["Hello", " ", "world", "."],
  "lang": "en"
}
```

```json
{
  "segmentId": "seg_d4e5f6",
  "domain": "speech",
  "startOffset": 0,
  "endOffset": 16000,
  "reason": "vad_boundary",
  "source": "segmentation_engine",
  "createdAtMs": 1714234567890,
  "segmentIndex": 0,
  "sourceAudioBufferId": "live_abc123",
  "sampleRate": 16000,
  "durationMs": 1000.0,
  "confidence": 0.93,
  "vadInfo": {
    "engine": "silero_vad",
    "score": 0.93
  }
}
```

---

## Cross-Domain Linkage: SegmentLink & SegmentLinkMap

> **Design rule:** `Segment` = within one domain. `SegmentLink` = between domains.  
> SegmentLink is **domain-agnostic** and **feature-agnostic**. Alignment is the first consumer (Phase 6), but TTS, STT, subtitle generation, and any future cross-domain feature reuse the same types.

### SegmentLink Type

```typescript
/**
 * A relationship between one text segment and one speech segment.
 * Feature-agnostic: used by alignment, TTS tracking, STT attribution, etc.
 */
interface SegmentLink {
  /** Unique link identifier */
  linkId: string;

  /** Text segment reference */
  textSegmentId: string;

  /** Speech segment reference */
  speechSegmentId: string;

  /** How this link was established */
  linkType: SegmentLinkType;

  /** Confidence of the link (0.0–1.0, optional) */
  confidence?: number;

  /** Link-specific metadata */
  meta?: Record<string, unknown>;
}

type SegmentLinkType =
  | 'alignment'         // produced by alignment model
  | 'proportional'      // estimated by proportional time mapping
  | 'vad_assisted'      // estimated using VAD boundaries as anchors
  | 'sequential'        // 1:1 sequential pairing (segment N text ↔ segment N speech)
  | 'tts_produced'      // TTS created audio from this text segment
  | 'stt_produced'      // STT created text from this audio segment
  | 'user_defined';     // explicitly set by SDK user
```

### SegmentLinkMap Type & APIs

```typescript
/**
 * Bidirectional, queryable, native-held N:M mapping between text and speech segments.
 * Lightweight: always in-memory, no spool, no eviction (link data is tiny).
 */
interface SegmentLinkMapRef {
  linkMapId: string;
}

// --- Creation ---
function createSegmentLinkMap(options?: {
  textBufferId?: string;
  audioBufferId?: string;
}): SegmentLinkMapRef;

// --- Write ---
function addSegmentLink(
  linkMap: SegmentLinkMapRef,
  link: { textSegmentId: string; speechSegmentId: string; linkType: SegmentLinkType; confidence?: number; meta?: Record<string, unknown> }
): SegmentLink;

function addSegmentLinks(linkMap: SegmentLinkMapRef, links: Array<{ ... }>): SegmentLink[];
function removeSegmentLink(linkMap: SegmentLinkMapRef, linkId: string): void;

// --- Bidirectional Query ---
function getSpeechSegmentsForText(linkMap: SegmentLinkMapRef, textSegmentId: string): SegmentLink[];
function getTextSegmentsForSpeech(linkMap: SegmentLinkMapRef, speechSegmentId: string): SegmentLink[];
function getAllSegmentLinks(linkMap: SegmentLinkMapRef, startIndex?: number, maxCount?: number): SegmentLink[];
function getSegmentLinkCount(linkMap: SegmentLinkMapRef): number;
function getSegmentLinkMapInfo(linkMap: SegmentLinkMapRef): SegmentLinkMapInfo;

interface SegmentLinkMapInfo {
  linkMapId: string;
  linkCount: number;
  textBufferId?: string;
  audioBufferId?: string;
}

// --- Lifecycle ---
function releaseSegmentLinkMap(linkMapId: string): void;
```

### Native Types

#### Kotlin (Android)

```kotlin
data class PaSegmentLink(
    val linkId: String,
    val textSegmentId: String,
    val speechSegmentId: String,
    val linkType: SegmentLinkType,
    val confidence: Float? = null,
    val metaJson: String? = null
)

enum class SegmentLinkType {
    ALIGNMENT, PROPORTIONAL, VAD_ASSISTED, SEQUENTIAL,
    TTS_PRODUCED, STT_PRODUCED, USER_DEFINED
}

class PaSegmentLinkMap(
    val linkMapId: String,
    val textBufferId: String? = null,
    val audioBufferId: String? = null
) {
    private val links = mutableMapOf<String, PaSegmentLink>()
    private val textIndex = mutableMapOf<String, MutableList<String>>()
    private val speechIndex = mutableMapOf<String, MutableList<String>>()
    // O(1) bidirectional lookup
}
```

#### C++ (iOS)

```cpp
enum class PaSegmentLinkType : uint8_t {
    Alignment, Proportional, VadAssisted, Sequential,
    TtsProduced, SttProduced, UserDefined
};

struct PaSegmentLink {
    std::string linkId;
    std::string textSegmentId;
    std::string speechSegmentId;
    PaSegmentLinkType linkType;
    std::optional<float> confidence;
    std::optional<std::string> metaJson;
};

class PaSegmentLinkMap {
public:
    std::unordered_map<std::string, PaSegmentLink> links_;
    std::unordered_multimap<std::string, std::string> textIndex_;
    std::unordered_multimap<std::string, std::string> speechIndex_;
};
```

### Serialization

```json
{
  "linkId": "lnk_x1y2z3",
  "textSegmentId": "seg_a1b2c3",
  "speechSegmentId": "seg_d4e5f6",
  "linkType": "tts_produced",
  "confidence": 1.0
}
```

### SegmentLink Validation Rules

1. `linkId` must be non-empty and unique within the map.
2. `textSegmentId` must be non-empty.
3. `speechSegmentId` must be non-empty.
4. `linkType` must be a valid enum value.
5. Duplicate `(textSegmentId, speechSegmentId)` pairs with same `linkType` are rejected.
6. Referenced segment IDs are **not** validated against buffer contents at link time (links may be created before segments are committed, or segments may be in different buffers).

### Use Cases by Feature

| Feature | linkType | Direction | When created |
|---|---|---|---|
| **Alignment** | `alignment` | text → speech | After alignment model runs |
| **TTS** | `tts_produced` | text → speech | After TTS synthesizes a text segment into audio |
| **STT** | `stt_produced` | speech → text | After STT transcribes an audio segment into text |
| **Subtitle/Caption** | `proportional` or `vad_assisted` | text ↔ speech | During subtitle timing generation |
| **Audiobook nav** | `sequential` or `alignment` | text ↔ speech | During navigation index build |
| **User/Custom** | `user_defined` | any | SDK user explicitly creates links |

---

## Relationship to Existing Types

### Migration from `LiveSegmentBuffer` Segment Model

The existing `LiveSegmentBuffer` uses `SegmentMeta` with `kind: 'speech' | 'alignment'`. The new model replaces this:

| Old Field | New Field | Notes |
|---|---|---|
| `id` | `segmentId` | Same semantics |
| `kind: 'speech'` | `domain: 'speech'` | Renamed for clarity |
| `kind: 'alignment'` | Removed | Alignment data becomes a feature-specific extension in `meta` |
| `startSample` | `startOffset` | Generalized (samples for speech, UTF-16 for text) |
| `endSample` | `endOffset` | Generalized |
| `payload.source` | `source` + `reason` | Split into two fields for clarity |
| `sourceAudioBufferId` | `sourceAudioBufferId` | Unchanged |
| `sampleRate` | `sampleRate` | Unchanged |
| `durationMs` | `durationMs` | Unchanged |

### Alignment Data

Alignment-specific metadata (text, timingMode, granularity, wordMetadata, etc.) moves into the `meta` field or a dedicated alignment extension type. This is not part of the core segment contract — alignment is a consumer that *reads* segments, not a segment *kind*.

---

## Validation Rules

### At Commit Time (Native)

1. `segmentId` must be non-empty and unique within the buffer.
2. `startOffset >= 0`.
3. `endOffset > startOffset` (zero-length segments are rejected).
4. `reason` must be a valid enum value.
5. `source` must be a valid enum value.
6. **Text:** `text` must be non-empty. `utf16Length` must match `text.length` (UTF-16).
7. **Speech:** `sourceAudioBufferId` must reference an existing buffer. `sampleRate > 0`. `durationMs > 0`.
8. `segmentIndex` must equal the buffer's `totalSegmentsWritten` counter (enforced internally).

### Invalid Segment Error

```typescript
{
  code: 'SEGMENT_INVALID',
  message: string,
  field?: string    // which field failed validation
}
```

---

## Implementation Steps

> Scope note (authoritative for migration orchestration):
> This sub-plan serves two purposes:
> 1) define the full long-term contract surface, and
> 2) deliver the **Phase 1a subset** from `segmentation_engine_overview.md`:
>    **core types + linkage types + serialization contract, no runtime logic**.
>
> Therefore, items that require runtime stores, public APIs, and behavior tests are
> intentionally marked post-1a.

### Segment Types (core)

1. **Define TypeScript types** in `src/types/segment.ts` (or equivalent SDK types file).
2. **Define Kotlin sealed interface** in `android/src/main/java/.../segment/Segment.kt`.
3. **Define C++ structs** in `ios/PicoAudio/segment/PaSegment.h`.
4. **Add JSON serialization** for both Kotlin (`toJson()`) and C++ (`toJsonString()`).
5. **Add validation functions** in both native implementations. *(Post-1a)*
6. **Write unit tests** for serialization roundtrip (native → JSON → TypeScript parse → compare). *(Post-1a)*
7. **Deprecate** old `SegmentMeta` type in `LiveSegmentBuffer` / `OfflineSegmentBuffer` (migrate in Sub-Plan 05). *(Post-1a)*

### SegmentLink & SegmentLinkMap (core, built alongside Segment types)

8. **Define `SegmentLink` TypeScript types** in `src/types/segment-link.ts`.
9. **Define `PaSegmentLink` Kotlin data class** in `android/src/main/java/.../segment/SegmentLink.kt`.
10. **Define `PaSegmentLink` C++ struct** in `ios/PicoAudio/segment/PaSegmentLink.h`.
11. **Implement `PaSegmentLinkMap`** native class (Kotlin + C++) with bidirectional index. *(Post-1a)*
12. **Add JSON serialization** for SegmentLink.
13. **Implement public APIs**: `createSegmentLinkMap`, `addSegmentLink`, `getSpeechSegmentsForText`, `getTextSegmentsForSpeech`, `getAllSegmentLinks`, `releaseSegmentLinkMap`. *(Post-1a)*
14. **Add validation functions** for link creation. *(Post-1a)*
15. **Write unit tests**: create/query/remove links, bidirectional lookup, N:M cardinality, duplicate rejection. *(Post-1a)*

### Phase 1a Completion Checklist

- [x] TypeScript contract types for `Segment` and `SegmentLink` are implemented.
- [x] Kotlin contract types for `Segment` and `SegmentLink` are implemented.
- [x] C++ contract types for `Segment` and `SegmentLink` are implemented.
- [x] Bridge serialization helpers exist for Segment and SegmentLink contracts.
- [x] JS entry exports are wired to the canonical segment module paths.
- [x] No LinkMap runtime behavior/API is required for 1a completion.
