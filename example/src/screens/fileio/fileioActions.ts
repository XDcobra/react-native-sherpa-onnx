import { Platform } from 'react-native';
import {
  pick,
  pickDirectory,
  saveDocuments,
  types,
  isErrorWithCode,
  errorCodes,
} from '@react-native-documents/picker';
import {
  DocumentDirectoryPath,
  mkdir,
  unlink,
} from '@dr.pogodin/react-native-fs';
import {
  saveAudioAsFile,
  type AudioSaveInput,
} from 'react-native-sherpa-onnx/audio';
import type {
  FileDestination,
  FileSource,
  ResolvedFileRef,
} from 'react-native-sherpa-onnx/fileio';
import {
  createEmptyLiveAudioBuffer,
  createOfflineAudioBufferFromFile,
  finalizeLiveAudioBuffer,
  ingestFileToLiveAudioBuffer,
  releasePipelineAudioBuffer,
} from 'react-native-sherpa-onnx/audiobuffer';

import { formatResolvedLocation } from '../../components/audioSaveUtils';
import { TEST_AUDIO_FILES } from '../../audioConfig';

/** Matches the “Audio source” cards on {@link FileIOScreen}. */
export type AudioSourceChoice =
  | 'liveAudioBuffer'
  | 'offlineAudioBuffer'
  | 'assetAudioFile';

/** Payload when the user taps Copy on the File I/O screen. */
export type FileioCopyInput = {
  /** Selected discriminant from {@link FileDestination}. */
  destinationKind: FileDestination['kind'];
  /** Live / offline buffer vs bundled asset path. */
  audioSource: AudioSourceChoice;
};

export type FileioCopyResult =
  | { status: 'success'; resolved: ResolvedFileRef; detail: string }
  | { status: 'canceled' }
  | { status: 'error'; message: string };

/** Same test clip as `example/android/.../assets/test_wavs/0-en.wav` (see {@link TEST_AUDIO_FILES}). */
const DEMO_SOURCE_RELATIVE_PATH = TEST_AUDIO_FILES.EN_1;

const SAVE_FORMAT = 'wav' as const;
const SAVE_OPTIONS = { outputSampleRateHz: 16000 } as const;

const FS_EXPORT_DIR = `${DocumentDirectoryPath}/SherpaOnnxFileIO/exports`;
const APP_EXPORT_RELATIVE = 'SherpaOnnxFileIO/exports';

function isPickCanceled(err: unknown): boolean {
  if (isErrorWithCode(err) && err.code === errorCodes.OPERATION_CANCELED) {
    return true;
  }
  return false;
}

async function resolveBundledTestWavAsFileSource(): Promise<FileSource> {
  return {
    kind: 'app',
    base: 'files',
    path: DEMO_SOURCE_RELATIVE_PATH,
  };
}

function mimeTypeForWav(): string {
  return 'audio/wav';
}

function buildContentTreeDestination(
  treeOrFolderUri: string,
  filename: string
): FileDestination {
  const trimmed = treeOrFolderUri.trim();
  if (trimmed.startsWith('content://')) {
    return {
      kind: 'contentTree',
      treeUri: trimmed,
      filename,
      mimeType: mimeTypeForWav(),
    };
  }
  if (trimmed.startsWith('file://')) {
    const dir = decodeURI(trimmed.replace(/^file:\/\//, '')).replace(/\/$/, '');
    return { kind: 'fs', path: `${dir}/${filename}` };
  }
  throw new Error(
    'Folder picker must return content:// (Android SAF) or file:// (iOS / simulator).'
  );
}

async function pickContentTreeDestination(): Promise<FileDestination> {
  const picked = await pickDirectory({ requestLongTermAccess: false });
  const uri = picked.uri?.trim();
  if (!uri) {
    throw new Error('Folder picker did not return a URI.');
  }
  const filename = `fileio-copy-${Date.now()}.wav`;
  return buildContentTreeDestination(uri, filename);
}

async function pickSecurityScopedDestination(): Promise<FileDestination> {
  if (Platform.OS !== 'ios') {
    throw new Error(
      'securityScoped destinations are for iOS. On Android use contentTree or app/fs.'
    );
  }
  const picked = await pick({
    mode: 'open',
    requestLongTermAccess: true,
    type: [types.audio],
  });
  const file = picked[0];
  const uri = file?.uri?.trim();
  if (!uri) {
    throw new Error('Document picker did not return a URI.');
  }
  return { kind: 'securityScoped', uri };
}

/** Fixed sandbox paths for blueprint demos (no picker). */
async function fixedDestinationForKind(
  kind: 'fs' | 'app'
): Promise<FileDestination> {
  const filename = `fileio-copy-${Date.now()}.wav`;
  if (kind === 'fs') {
    await mkdir(FS_EXPORT_DIR, { NSURLIsExcludedFromBackupKey: false }).catch(
      () => {}
    );
    return { kind: 'fs', path: `${FS_EXPORT_DIR}/${filename}` };
  }
  return {
    kind: 'app',
    base: 'documents',
    path: `${APP_EXPORT_RELATIVE}/${filename}`,
  };
}

type PreparedInput = {
  input: AudioSaveInput;
  dispose: () => Promise<void>;
};

/**
 * Always starts from the bundled example WAV, then exposes it either as a
 * {@link FileSource} (asset path) or as a pipeline buffer (offline / live ingest).
 */
async function prepareAudioSaveInput(
  audioSource: AudioSourceChoice
): Promise<PreparedInput> {
  const wavSource = await resolveBundledTestWavAsFileSource();

  if (audioSource === 'assetAudioFile') {
    return {
      input: wavSource,
      dispose: async () => {},
    };
  }

  if (audioSource === 'offlineAudioBuffer') {
    const ref = await createOfflineAudioBufferFromFile(wavSource, {
      forceMono: true,
    });
    return {
      input: ref.bufferId,
      dispose: async () => {
        await releasePipelineAudioBuffer(ref.bufferId).catch(() => {});
      },
    };
  }

  const live = await createEmptyLiveAudioBuffer({
    sampleRate: 16000,
    channelCount: 1,
  });
  let ingest: Awaited<ReturnType<typeof ingestFileToLiveAudioBuffer>> | null =
    null;
  try {
    ingest = await ingestFileToLiveAudioBuffer(live.bufferId, wavSource, {
      forceMono: true,
      autoFinalize: false,
    });
    await ingest.done;
    await finalizeLiveAudioBuffer(live.bufferId);
  } catch (e) {
    ingest?.cancel();
    await releasePipelineAudioBuffer(live.bufferId).catch(() => {});
    throw e;
  }

  return {
    input: live.bufferId,
    dispose: async () => {
      await releasePipelineAudioBuffer(live.bufferId).catch(() => {});
    },
  };
}

/**
 * `contentUri` is awkward from JS alone (you usually need a “Save as” dialog).
 * We encode with {@link saveAudioAsFile} into app cache, then use {@link saveDocuments}
 * so the user picks the final `content://` location — same UX as other Android apps.
 */
async function saveViaStagingAndSaveDocuments(
  input: PreparedInput['input']
): Promise<ResolvedFileRef> {
  const stagingRel = `fileio-staging/fileio-temp-${Date.now()}.wav`;
  const stagingDest: FileDestination = {
    kind: 'app',
    base: 'cache',
    path: stagingRel,
  };

  const staged = await saveAudioAsFile(
    input,
    stagingDest,
    SAVE_FORMAT,
    SAVE_OPTIONS
  );
  if (staged.kind !== 'fs') {
    throw new Error(
      'Expected a filesystem path from app cache staging; got content URI.'
    );
  }
  const fsPath = staged.path;

  const sourceUri = encodeURI(
    fsPath.startsWith('file://') ? fsPath : `file://${fsPath}`
  );

  try {
    const responses = await saveDocuments({
      sourceUris: [sourceUri],
      mimeType: mimeTypeForWav(),
      fileName: `fileio-copy-${Date.now()}.wav`,
    });
    const first = responses[0];
    if (first?.error) {
      throw new Error(first.error);
    }
    const uri = first?.uri?.trim();
    if (!uri) {
      throw new Error('Save dialog did not return a target URI.');
    }
    return uri.startsWith('content://')
      ? { kind: 'contentUri', uri }
      : { kind: 'fs', path: decodeURI(uri.replace(/^file:\/\//, '')) };
  } finally {
    await unlink(fsPath).catch(() => {});
  }
}

/**
 * Invoked when the user presses **Copy** on the File I/O screen.
 *
 * Source is always the bundled `0-en.wav` ({@link DEMO_SOURCE_RELATIVE_PATH}).
 * Destination follows {@link FileioCopyInput.destinationKind} (fixed paths vs pickers).
 */
export async function runFileioCopy(
  input: FileioCopyInput
): Promise<FileioCopyResult> {
  let prepared: PreparedInput | null = null;
  try {
    prepared = await prepareAudioSaveInput(input.audioSource);

    let resolved: ResolvedFileRef;

    switch (input.destinationKind) {
      case 'fs':
      case 'app': {
        const dest = await fixedDestinationForKind(input.destinationKind);
        resolved = await saveAudioAsFile(
          prepared.input,
          dest,
          SAVE_FORMAT,
          SAVE_OPTIONS
        );
        break;
      }
      case 'contentTree': {
        const dest = await pickContentTreeDestination();
        resolved = await saveAudioAsFile(
          prepared.input,
          dest,
          SAVE_FORMAT,
          SAVE_OPTIONS
        );
        break;
      }
      case 'contentUri': {
        resolved = await saveViaStagingAndSaveDocuments(prepared.input);
        break;
      }
      case 'securityScoped': {
        const dest = await pickSecurityScopedDestination();
        resolved = await saveAudioAsFile(
          prepared.input,
          dest,
          SAVE_FORMAT,
          SAVE_OPTIONS
        );
        break;
      }
    }

    const location = formatResolvedLocation(resolved);
    const detail = [
      `Output: ${location}`,
      `Source card: ${input.audioSource}`,
      `Bundled WAV: ${DEMO_SOURCE_RELATIVE_PATH}`,
    ].join('\n');

    return { status: 'success', resolved, detail };
  } catch (e) {
    if (isPickCanceled(e)) {
      return { status: 'canceled' };
    }
    const message = e instanceof Error ? e.message : String(e);
    return { status: 'error', message };
  } finally {
    await prepared?.dispose();
  }
}

/**
 * Opens the system document picker ({@code ACTION_OPEN_DOCUMENT} / iOS open panel).
 * Resolves with the first picked file’s metadata; no-op if the user cancels.
 */
export async function openFileioDocumentPicker(): Promise<void> {
  try {
    await pick({
      mode: 'open',
      type: types.allFiles,
    });
  } catch (e) {
    if (isErrorWithCode(e) && e.code === errorCodes.OPERATION_CANCELED) {
      return;
    }
    throw e;
  }
}
