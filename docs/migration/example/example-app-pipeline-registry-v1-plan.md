# Example app migration plan: pipeline registry (V1)

## Purpose

Replace screen-centric example flows with a pipeline-first learning app that mirrors SDK composition:

- users select pipeline elements (nodes)
- app enforces compatible next steps via input/output contracts
- each run doubles as an integration test for the SDK

Primary objective: **minimal boilerplate, maximal clarity**.

---

## Design principles

1. **Use-case first, API second**
   - users build real flows (Mic -> Live -> STT -> TextOut), not isolated API calls.

2. **Typed composition**
   - every node declares accepted inputs and produced outputs.

3. **Guided next-step UX**
   - UI offers only nodes that can consume currently selected artifact.

4. **Linear graph V1**
   - single active chain (no branching/merge) to keep complexity low.

5. **Test harness by design**
   - each completed chain is a smoke/integration test path.

---

## Scope (V1)

### In scope

- Full replacement of current feature screens with a single pipeline-first app flow
- New pipeline-runner screen as the primary (and only) demo experience
- Registry-driven node catalog
- Linear chain execution
- Artifact inspector and cleanup controls

### Out of scope (V2+)

- arbitrary graph branching/merging
- persisted graph templates
- visual node editor / drag-and-drop canvas
- distributed/parallel pipeline scheduling
- maintaining parallel legacy/feature screens

---

## Core data model

## Artifact types (contract layer)

Use a compact discriminated union for runtime compatibility checks:

- `fileSource`
- `fileRef`
- `offlineAudioBuffer`
- `liveAudioBufferRecording`
- `liveAudioBufferFinished`
- `offlineTextBuffer`
- `liveTextBuffer`
- `pcmPlayer`
- `streamingPipelineHandle`
- `ttsPipelineHandle`
- `metadata` (generic status/output summaries)

Each artifact entry stores:

- `artifactId` (app-level UUID)
- `kind` (one of above)
- `label`
- `payload` (SDK ref/handle/path)
- `createdAt`

## Node definition shape

```ts
type PipelineNodeDefinition = {
  id: string;
  label: string;
  category: 'source' | 'transform' | 'sink' | 'control';
  description: string;
  inputKinds: ArtifactKind[];   // [] => source node
  outputKinds: ArtifactKind[];  // empty allowed for terminal actions
  paramsSchema?: NodeParamSchema;
  run: (ctx: NodeRunContext) => Promise<NodeRunResult>;
};
```

Execution contracts:

- `NodeRunContext` provides selected input artifact(s), node params, shared services (logger, cancellation, registry hooks).
- `NodeRunResult` returns created artifacts + status messages.

---

## Suggested initial node catalog (V1)

Start with a small, high-value set that covers your main SDK paths.

## Source nodes

1. **Pick FileSource**
   - output: `fileSource`
2. **Create Empty Live Audio Buffer**
   - output: `liveAudioBufferRecording`
3. **Create Empty Offline Audio Buffer**
   - output: `offlineAudioBuffer`
4. **Create Offline Text Buffer From Text**
   - output: `offlineTextBuffer`

## Audio buffer transform nodes

5. **Decode File -> Offline Audio Buffer**
   - input: `fileSource`
   - output: `offlineAudioBuffer`
6. **Ingest File -> Live Audio Buffer**
   - input: `liveAudioBufferRecording` + `fileSource`
   - output: `liveAudioBufferRecording` (mutated/updated)
7. **Finalize Live Audio Buffer**
   - input: `liveAudioBufferRecording`
   - output: `liveAudioBufferFinished`
8. **Live -> Offline Audio Buffer**
   - input: `liveAudioBufferFinished` (or recording, mode-dependent)
   - output: `offlineAudioBuffer`
9. **Append Offline -> Live**
   - input: `offlineAudioBuffer` + `liveAudioBufferRecording`
   - output: `liveAudioBufferRecording`

## STT / TTS / enhancement nodes

10. **Offline STT**
    - input: `offlineAudioBuffer`
    - output: `metadata` (transcript)
11. **Start Streaming STT Pipeline**
    - input: `liveAudioBufferRecording` + `liveTextBuffer`
    - output: `streamingPipelineHandle`
12. **Create Live Text Buffer**
    - output: `liveTextBuffer`
13. **Start Streaming TTS Pipeline**
    - input: `offlineTextBuffer` + `liveAudioBufferRecording`
    - output: `ttsPipelineHandle`
14. **Enhancement Offline**
    - input: `offlineAudioBuffer` + `offlineAudioBuffer` (out target)
    - output: `offlineAudioBuffer`
15. **Enhancement Streaming**
    - input: `liveAudioBufferRecording` + `liveAudioBufferRecording` (out target)
    - output: `streamingPipelineHandle`

## Sink/control nodes

16. **Save Audio As File**
    - input: `offlineAudioBuffer | liveAudioBufferFinished | fileSource`
    - output: `fileRef`
17. **Play With PCM Player**
    - input: `offlineAudioBuffer | liveAudioBufferRecording | liveAudioBufferFinished`
    - output: `pcmPlayer`
18. **Pause/Resume/Destroy PCM Player**
    - input: `pcmPlayer`
    - output: `metadata`
19. **Release Artifact**
    - input: any releasable artifact
    - output: `metadata`

---

## Guided next-step algorithm

Given current selected artifact(s):

1. Filter registry where `inputKinds` are satisfiable by available artifacts.
2. Rank by category priority:
   - `transform` first
   - then `sink`
   - then `control`
3. Show top suggestions and full compatible list.
4. Block incompatible node execution with clear explanation:
   - expected input kinds
   - currently selected kind(s)

For V1 linear mode:

- default selected artifact is the last produced one.
- advanced picker allows selecting any previous artifact.

---

## UI structure (minimal boilerplate)

Single main screen: `PipelineLabScreen`

Sections:

1. **Run Controls**
   - New run / reset / release all

2. **Artifact Timeline**
   - cards for produced artifacts (kind, state, key fields)

3. **Next Action Suggestions**
   - compatible nodes computed from current selection

4. **Node Config Panel**
   - parameter form for selected node

5. **Execution Log**
   - structured events/errors for debugging and SDK learning

6. **Quick Actions**
   - finalize live, save file, play, cleanup

---

## Suggested internal app modules

- `example/src/pipeline-registry/types.ts`
- `example/src/pipeline-registry/nodes/*.ts`
- `example/src/pipeline-registry/nodeRegistry.ts`
- `example/src/pipeline-runtime/usePipelineRunStore.ts`
- `example/src/pipeline-runtime/compatibility.ts`
- `example/src/screens/pipeline/PipelineLabScreen.tsx`
- `example/src/screens/pipeline/components/*`
- `example/src/navigation/*` (routes simplified to pipeline app entry)
- `example/src/screens/legacy/*` (temporary holding area during migration, then delete)

---

## Migration phases (clean restart)

### Phase 1: runtime foundation

- implement artifact model, registry contracts, compatibility filter
- add minimal Pipeline Lab screen shell
- add new navigation entry as default app landing experience

### Phase 2: core audio path

- implement nodes: file source -> offline/live -> finalize -> save -> play
- verify end-to-end without STT/TTS/enhancement

### Phase 3: speech pipelines

- add streaming STT + text buffer nodes
- add streaming TTS and enhancement nodes

### Phase 4: hard cutover + cleanup

- add better logs/tooltips
- remove all old feature screens from navigation
- remove obsolete screen-specific orchestration helpers/state
- delete legacy screen files after parity checks pass

### Phase 5: stabilization

- run full app smoke pass on Android+iOS using only Pipeline Lab
- fix regressions introduced by screen removal
- lock new structure as the only example-app architecture

---

## Screen removal policy

This migration is a deliberate clean restart:

- do not keep old STT/TTS/Enhancement/etc. feature screens in parallel
- do not add \"legacy\" tabs/routes in final app
- all demo flows must be representable via registry nodes inside Pipeline Lab

Allowed temporary state during migration branch:

- old screens can exist only until node parity is verified
- once parity passes, remove them in the same migration before merge

---

## Testing value (built-in)

Each node execution can serve as a deterministic smoke check:

- run success/failure + error code
- artifact state transitions
- cleanup verification

Recommended baseline test flows:

1. `FileSource -> OfflineAudioBuffer -> SaveAudioAsFile`
2. `CreateEmptyLive -> IngestFile -> Finalize -> SaveAudioAsWav16k`
3. `CreateEmptyLive -> MicStart/Stop -> Finalize -> LiveToOffline`
4. `OfflineText -> StreamingTTS -> LiveAudio -> PCM Player`

---

## Non-goals

- replacing full documentation with in-app text
- implementing a generic graph engine framework
- supporting arbitrary N-input/N-output graph scheduling in V1

---

## Success criteria

- users can build and run common SDK flows without touching per-screen custom logic
- next-step suggestions prevent invalid pipeline combinations
- major SDK paths are testable from one screen with minimal setup
- example app code per new demo is mostly node definition + params (not orchestration boilerplate)
- no legacy feature screens remain in app navigation or codebase

