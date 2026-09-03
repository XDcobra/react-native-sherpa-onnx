# Speaker Diarization

**Status:** Offline batch is available — see **[diarization-offline.md](./diarization-offline.md)**.

For **named-speaker** enroll / identify / verify, see
[speaker-identification-offline.md](./speaker-identification-offline.md). Diarization
uses anonymous cluster indices; match clusters to enrolled names via
`getClusterEmbeddings()` + `SpeakerEmbeddingManager.search`.

## Native crash diagnostics

If native code fails or the app crashes but the tombstone shows only a UI/GPU thread,
inspect the SDK **last-activity ring buffer**. Full details:
[native-diagnostics.md](./native-diagnostics.md).
