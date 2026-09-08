# Named diarization timeline (SID × diarization)

Compose offline [diarization](./diarization-offline.md) with
[speaker identification](./speaker-identification-offline.md) to turn anonymous
cluster indices into a **who-spoke-when** timeline with enrolled names.

Diarization invents clusters; SID holds the name gallery. Prefer
**`mapDiarizationToNames`** (centroids → `sid.search` → named timeline). The
manual Cosine / `exportEnrollments` path below shows the same internals if you
need a custom matcher.

## Scenario

| Audio | Role |
| --- | --- |
| `alice.wav`, `bob.wav`, `carol.wav` | One speaker each → SID `enroll` |
| `meeting.wav` | Four speakers (Alice, Bob, Carol + unknown guest) → `diarize` |

**Goal:** a who-spoke-when timeline with names where enrollment exists, and
`null` for the guest.

## Recommended: `mapDiarizationToNames`

```ts
import {
  createDiarization,
  detectDiarizationModel,
  mapDiarizationToNames,
} from 'react-native-sherpa-onnx/diarization';
import {
  createSpeakerIdentification,
  detectSpeakerEmbeddingModel,
} from 'react-native-sherpa-onnx/speaker-identification';
import {
  createOfflineAudioBufferFromFile,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import {
  createEmptyOfflineSegmentBuffer,
  releasePipelineSegmentBuffer,
} from 'react-native-sherpa-onnx/segmentbuffer';

// --- Paths (fs) — use the SAME embedding pack for SID and diarization ---
const segPack = {
  kind: 'fs' as const,
  path: '/absolute/path/to/sherpa-onnx-pyannote-segmentation-3-0',
};
const embPack = {
  kind: 'fs' as const,
  path: '/absolute/path/to/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k',
};

const embDetect = await detectSpeakerEmbeddingModel(embPack, {
  modelType: 'auto',
});
// embDetect.success === true
// embDetect.modelType === '3d-speaker' (example)

const sid = await createSpeakerIdentification({
  modelSource: embPack,
  modelType: (embDetect.modelType as 'wespeaker' | '3d-speaker' | 'nemo') ?? 'auto',
  numThreads: 2,
  provider: 'cpu',
});

const alice = await createOfflineAudioBufferFromFile({
  kind: 'fs',
  path: '/absolute/path/alice.wav',
});
const bob = await createOfflineAudioBufferFromFile({
  kind: 'fs',
  path: '/absolute/path/bob.wav',
});
const carol = await createOfflineAudioBufferFromFile({
  kind: 'fs',
  path: '/absolute/path/carol.wav',
});

await sid.enroll('alice', alice);
// gallery now contains alice (1 averaged embedding)

await sid.enroll('bob', bob);
// gallery: alice, bob

await sid.enroll('carol', carol);
// gallery: alice, bob, carol
// await sid.listSpeakers() → ['alice', 'bob', 'carol']
// await sid.numSpeakers() → 3

const meeting = await createOfflineAudioBufferFromFile({
  kind: 'fs',
  path: '/absolute/path/meeting.wav',
});

const segDetect = await detectDiarizationModel(segPack);
// segDetect.success === true
// segDetect.modelType === 'pyannote' (example)
// segDetect.paths.model → ONNX path inside the pack

const diar = await createDiarization({
  segmentation: {
    modelSource: { kind: 'fs', path: segDetect.paths!.model! },
  },
  // Same embedding weights as SID → shared Runner registry, matching dim
  embedding: { modelSource: embPack },
  clustering: { threshold: 0.5 },
});

const diarizationSegments = await createEmptyOfflineSegmentBuffer({
  sourceAudioBufferId: meeting,
});

const diarResult = await diar.diarize(meeting, diarizationSegments);
// diarResult.status === 'complete'
// diarResult.numSpeakers === 4          // alice, bob, carol, guest
// diarResult.segmentCount === 12        // example span count
// diarResult.sampleRate === 16000

const { clusterToName, timeline } = await mapDiarizationToNames(
  diar,
  sid,
  diarizationSegments,
  { threshold: 0.5 }
);
// Internally: getClusterEmbeddings() → sid.search(centroid) per cluster
//             → read diarization rows from diarizationSegments → merge names
//
// clusterToName → Map {
//   0 => 'alice',
//   1 => 'bob',
//   2 => 'carol',
//   3 => null,        // guest — below threshold / not enrolled
// }
//
// timeline → [
//   { startSec: 0.42, endSec: 3.10, clusterId: 0, name: 'alice', ... },
//   { startSec: 2.80, endSec: 5.55, clusterId: 1, name: 'bob', ... },   // overlap possible
//   { startSec: 5.60, endSec: 8.20, clusterId: 2, name: 'carol', ... },
//   { startSec: 8.30, endSec: 11.0, clusterId: 3, name: null, ... },    // unknown guest
//   ...
// ]

console.log(timeline);

await releasePipelineSegmentBuffer(diarizationSegments);
await releasePipelineAudioBuffer(meeting);
await releasePipelineAudioBuffer(alice);
await releasePipelineAudioBuffer(bob);
await releasePipelineAudioBuffer(carol);
await diar.destroy();
await sid.destroy();
```

### Notes

- **Not** `sid.identify(meeting)` — that assumes one speaker for the whole clip.
- **Not** `labelOfflineSegments` on diarization rows — that path only accepts
  `kind: 'speech'` (VAD-style spans). Naming is **cluster centroid → gallery**.
- Overlapping times with different `clusterId` / `name` are valid (two people at once).
- Re-run `mapDiarizationToNames` after every new `diarize` (centroids are per recording).
- Prefer the **same** embedding model for SID enroll and `createDiarization.embedding`.
- Numeric values in comments are illustrative.

## Power user: manual centroid matching

Same use case without the helper — useful if you need a custom score function or
want to see how SID and diarization compose. Matching is
`getClusterEmbeddings()` + gallery compare (`exportEnrollments` Cosine, or
`sid.search` per centroid) + merge onto segment rows.

```ts
import {
  createDiarization,
  detectDiarizationModel,
} from 'react-native-sherpa-onnx/diarization';
import {
  createSpeakerIdentification,
  detectSpeakerEmbeddingModel,
} from 'react-native-sherpa-onnx/speaker-identification';
import {
  createOfflineAudioBufferFromFile,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';
import {
  createEmptyOfflineSegmentBuffer,
  getOfflineSegmentBufferSegments,
  releasePipelineSegmentBuffer,
} from 'react-native-sherpa-onnx/segmentbuffer';

const THRESHOLD = 0.5; // cosine similarity; tune per model / domain

/** Cosine similarity for L2-ish embedding vectors (same idea as manager.search). */
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

function bestEnrolledName(
  clusterEmb: Float32Array,
  gallery: { name: string; embeddings: number[][] }[],
  threshold: number
): string | null {
  let bestName: string | null = null;
  let bestScore = -Infinity;
  for (const speaker of gallery) {
    for (const row of speaker.embeddings) {
      const score = cosine(clusterEmb, Float32Array.from(row));
      if (score > bestScore) {
        bestScore = score;
        bestName = speaker.name;
      }
    }
  }
  return bestScore >= threshold ? bestName : null;
}

const segPack = {
  kind: 'fs' as const,
  path: '/absolute/path/to/sherpa-onnx-pyannote-segmentation-3-0',
};
const embPack = {
  kind: 'fs' as const,
  path: '/absolute/path/to/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k',
};

const embDetect = await detectSpeakerEmbeddingModel(embPack, {
  modelType: 'auto',
});

const sid = await createSpeakerIdentification({
  modelSource: embPack,
  modelType: (embDetect.modelType as 'wespeaker' | '3d-speaker' | 'nemo') ?? 'auto',
  numThreads: 2,
  provider: 'cpu',
});

const alice = await createOfflineAudioBufferFromFile({
  kind: 'fs',
  path: '/absolute/path/alice.wav',
});
const bob = await createOfflineAudioBufferFromFile({
  kind: 'fs',
  path: '/absolute/path/bob.wav',
});
const carol = await createOfflineAudioBufferFromFile({
  kind: 'fs',
  path: '/absolute/path/carol.wav',
});

await sid.enroll('alice', alice);
await sid.enroll('bob', bob);
await sid.enroll('carol', carol);

const meeting = await createOfflineAudioBufferFromFile({
  kind: 'fs',
  path: '/absolute/path/meeting.wav',
});

const segDetect = await detectDiarizationModel(segPack);

const diar = await createDiarization({
  segmentation: {
    modelSource: { kind: 'fs', path: segDetect.paths!.model! },
  },
  embedding: { modelSource: embPack },
  clustering: { threshold: 0.5 },
});

const diarizationSegments = await createEmptyOfflineSegmentBuffer({
  sourceAudioBufferId: meeting,
});

await diar.diarize(meeting, diarizationSegments);

const clusters = await diar.getClusterEmbeddings();
// clusters[i] → { speaker: number, embedding: Float32Array }

const gallery = await sid.exportEnrollments();
// gallery.speakers → [{ name, embeddings: number[][] }, ...]

const clusterToName = new Map<number, string | null>();
for (const row of clusters) {
  // Equivalent one-liner with the public SID API:
  // const name = await sid.search(row.embedding, { threshold: THRESHOLD });
  const name = bestEnrolledName(row.embedding, gallery.speakers, THRESHOLD);
  clusterToName.set(row.speaker, name);
}
// clusterToName → Map { 0 => 'alice', 1 => 'bob', 2 => 'carol', 3 => null }

const raw = await getOfflineSegmentBufferSegments(diarizationSegments, 0, 4096);
// raw[i].kind === 'diarization'
// raw[i].payload === { source: 'diarization', speaker: <clusterId> }

const timeline = raw
  .filter((s) => s.kind === 'diarization')
  .map((s) => {
    const clusterId = s.payload!.speaker;
    const startSec = s.startSample / s.sampleRate;
    const endSec = s.endSample / s.sampleRate;
    return {
      startSec,
      endSec,
      clusterId,
      name: clusterToName.get(clusterId) ?? null,
    };
  });

console.log(timeline);

await releasePipelineSegmentBuffer(diarizationSegments);
await releasePipelineAudioBuffer(meeting);
await releasePipelineAudioBuffer(alice);
await releasePipelineAudioBuffer(bob);
await releasePipelineAudioBuffer(carol);
await diar.destroy();
await sid.destroy();
```

## Related

- [diarization-offline.md](./diarization-offline.md) — `diarize` / `getClusterEmbeddings` / `mapDiarizationToNames`
- [speaker-identification-offline.md](./speaker-identification-offline.md) — enroll / `search` / gallery
