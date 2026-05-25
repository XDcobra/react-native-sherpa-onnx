import { Platform } from 'react-native';
import {
  pick,
  types,
  isErrorWithCode,
  errorCodes,
} from '@react-native-documents/picker';
import { DocumentDirectoryPath, mkdir } from '@dr.pogodin/react-native-fs';
import { copyFile } from 'react-native-sherpa-onnx/fileio';
import type { AppBaseDir, FileSource } from 'react-native-sherpa-onnx/fileio';

import {
  type CodecAssetFormat,
  CODEC_ASSET_ENTRIES,
  fileSourceFromBundledCodecFormat,
  TEST_AUDIO_FILES,
  TEST_CODEC_FILES,
} from '../../audioConfig';
import {
  fileSourceFromBundledPath,
  toFileSource,
} from '../../utils/fileSourceFromUri';

/** How the active sample is exposed as a {@link FileSource}. */
export type FileioInputChannelId =
  | 'app_files'
  | 'app_apkAsset'
  | 'app_cache'
  | 'app_documents'
  | 'app_tmp'
  | 'app_externalFiles'
  | 'fs'
  | 'contentUri'
  | 'securityScoped'
  | 'pad';

export type FileioSampleSelection =
  | { kind: 'codec'; format: CodecAssetFormat }
  | { kind: 'legacy' };

export type FileioInputSource = {
  fileSource: FileSource;
  label: string;
  channelId: FileioInputChannelId;
  /** Bundled relative path when derived from a sample chip */
  bundledPath?: string;
};

export type FileioInputChannelMeta = {
  id: FileioInputChannelId;
  title: string;
  hint: string;
  /** Uses the selected sample chip without a system file picker */
  automatic: boolean;
  supported: boolean;
  unsupportedReason?: string;
};

const INPUT_STAGING_REL = 'SherpaOnnxFileIO/input';
const FS_INPUT_DIR = `${DocumentDirectoryPath}/SherpaOnnxFileIO/input`;
const DEFAULT_PAD_PACK = 'demo_codec_pack';

function isPickCanceled(err: unknown): boolean {
  return isErrorWithCode(err) && err.code === errorCodes.OPERATION_CANCELED;
}

function basename(relativePath: string): string {
  const parts = relativePath.split('/');
  return parts[parts.length - 1] ?? relativePath;
}

function sampleLabel(selection: FileioSampleSelection): string {
  if (selection.kind === 'legacy') {
    return 'Legacy WAV';
  }
  return (
    CODEC_ASSET_ENTRIES.find((e) => e.format === selection.format)?.label ??
    selection.format.toUpperCase()
  );
}

function sampleBundledPath(selection: FileioSampleSelection): string {
  return selection.kind === 'legacy'
    ? TEST_AUDIO_FILES.EN_1
    : TEST_CODEC_FILES[selection.format];
}

/** Canonical bundled read path (`app` + `files`), used as copy source. */
export function canonicalBundledFileSource(
  selection: FileioSampleSelection
): FileSource {
  const path = sampleBundledPath(selection);
  return fileSourceFromBundledPath(path);
}

export function listAllSampleSelections(): FileioSampleSelection[] {
  return [
    ...CODEC_ASSET_ENTRIES.map(
      (entry): FileioSampleSelection => ({
        kind: 'codec',
        format: entry.format,
      })
    ),
    { kind: 'legacy' },
  ];
}

/** Automatic FileSource channels included in batch runs (excludes Pick channels). */
export function listAutomaticInputChannelIds(): FileioInputChannelId[] {
  return listFileioInputChannels()
    .filter((ch) => ch.automatic && ch.supported)
    .map((ch) => ch.id);
}

export function listFileioInputChannels(): FileioInputChannelMeta[] {
  const isAndroid = Platform.OS === 'android';
  const isIos = Platform.OS === 'ios';

  return [
    {
      id: 'app_apkAsset',
      title: 'app / apkAsset',
      hint: isAndroid
        ? 'APK assets/ (test_codec/sample.*) — default on Android'
        : 'Android-only',
      automatic: true,
      supported: isAndroid,
      unsupportedReason: 'apkAsset is Android-only',
    },
    {
      id: 'app_files',
      title: 'app / files',
      hint: isAndroid
        ? 'Sandbox files/ dir (sample copied from apkAsset)'
        : 'Sandbox + bundle Resources fallback (sample copied on iOS)',
      automatic: true,
      supported: true,
    },
    {
      id: 'app_cache',
      title: 'app / cache',
      hint: 'Copy sample into app cache, then read',
      automatic: true,
      supported: true,
    },
    {
      id: 'app_documents',
      title: 'app / documents',
      hint: 'Copy sample into documents, then read',
      automatic: true,
      supported: true,
    },
    {
      id: 'app_tmp',
      title: 'app / tmp',
      hint: 'Copy sample into tmp, then read',
      automatic: true,
      supported: true,
    },
    {
      id: 'app_externalFiles',
      title: 'app / externalFiles',
      hint: 'Copy sample into external files (Android)',
      automatic: true,
      supported: isAndroid,
      unsupportedReason: 'externalFiles is Android-only',
    },
    {
      id: 'fs',
      title: 'fs',
      hint: 'Copy sample to an absolute sandbox path, then read',
      automatic: true,
      supported: true,
    },
    {
      id: 'contentUri',
      title: 'contentUri',
      hint: 'SAF document URI — pick any audio file (Android)',
      automatic: false,
      supported: isAndroid,
      unsupportedReason: 'contentUri input is Android-only',
    },
    {
      id: 'securityScoped',
      title: 'securityScoped',
      hint: 'Security-scoped URL — pick any audio file (iOS)',
      automatic: false,
      supported: isIos,
      unsupportedReason: 'securityScoped input is iOS-only',
    },
    {
      id: 'pad',
      title: 'pad',
      hint: 'Play Asset Delivery — path from sample chip + pack name',
      automatic: true,
      supported: isAndroid,
      unsupportedReason: 'PAD is Android-only',
    },
  ];
}

async function copySampleToAppBase(
  selection: FileioSampleSelection,
  base: AppBaseDir
): Promise<FileSource> {
  const bundledPath = sampleBundledPath(selection);
  const destRel = `${INPUT_STAGING_REL}/${basename(bundledPath)}`;
  await copyFile(
    canonicalBundledFileSource(selection),
    {
      kind: 'app',
      base,
      path: destRel,
    },
    { overwrite: true, createParentDirectories: true }
  );
  return { kind: 'app', base, path: destRel };
}

async function copySampleToFs(
  selection: FileioSampleSelection
): Promise<FileSource> {
  const bundledPath = sampleBundledPath(selection);
  const destPath = `${FS_INPUT_DIR}/${basename(bundledPath)}`;
  await mkdir(FS_INPUT_DIR).catch(() => {});
  await copyFile(
    canonicalBundledFileSource(selection),
    { kind: 'fs', path: destPath },
    { overwrite: true }
  );
  return { kind: 'fs', path: destPath };
}

/**
 * Resolve the active {@link FileSource} for a sample chip + channel.
 * Pick channels require `manualPick` from {@link pickFileioInputForChannel}.
 */
export async function resolveFileioInputSource(params: {
  selection: FileioSampleSelection;
  channelId: FileioInputChannelId;
  manualPick?: FileioInputSource;
  padPackName?: string;
}): Promise<FileioInputSource> {
  const { selection, channelId, manualPick, padPackName } = params;
  const bundledPath = sampleBundledPath(selection);
  const sampleName = sampleLabel(selection);

  if (channelId === 'contentUri' || channelId === 'securityScoped') {
    if (!manualPick) {
      throw new Error('Choose an audio file for this FileSource channel.');
    }
    return {
      ...manualPick,
      channelId,
      bundledPath: manualPick.bundledPath,
    };
  }

  let fileSource: FileSource;
  let channelLabel: string;

  switch (channelId) {
    case 'app_apkAsset':
      fileSource = { kind: 'app', base: 'apkAsset', path: bundledPath };
      channelLabel = 'app/apkAsset';
      break;
    case 'app_files':
      fileSource = await copySampleToAppBase(selection, 'files');
      channelLabel = 'app/files (copied)';
      break;
    case 'app_cache':
      fileSource = await copySampleToAppBase(selection, 'cache');
      channelLabel = 'app/cache (copied)';
      break;
    case 'app_documents':
      fileSource = await copySampleToAppBase(selection, 'documents');
      channelLabel = 'app/documents (copied)';
      break;
    case 'app_tmp':
      fileSource = await copySampleToAppBase(selection, 'tmp');
      channelLabel = 'app/tmp (copied)';
      break;
    case 'app_externalFiles':
      fileSource = await copySampleToAppBase(selection, 'externalFiles');
      channelLabel = 'app/externalFiles (copied)';
      break;
    case 'fs':
      fileSource = await copySampleToFs(selection);
      channelLabel = 'fs (copied)';
      break;
    case 'pad': {
      const pack = padPackName?.trim() || DEFAULT_PAD_PACK;
      fileSource = { kind: 'pad', packName: pack, path: bundledPath };
      channelLabel = `pad:${pack}`;
      break;
    }
    default:
      throw new Error(`Unknown FileSource channel: ${channelId}`);
  }

  return {
    fileSource,
    label: `${sampleName} · ${channelLabel}`,
    channelId,
    bundledPath,
  };
}

/** Open the system picker for channels that cannot be satisfied from bundled samples. */
export async function pickFileioInputForChannel(
  channelId: 'contentUri' | 'securityScoped'
): Promise<FileioInputSource | null> {
  try {
    const picked = await pick({
      mode: 'open',
      type: [types.audio],
      requestLongTermAccess: channelId === 'securityScoped',
    });
    const file = picked[0];
    const uri = file?.uri?.trim();
    if (!uri) {
      return null;
    }

    const fileSource: FileSource =
      channelId === 'securityScoped'
        ? { kind: 'securityScoped', uri }
        : toFileSource(uri);

    const name =
      file.name?.trim() ||
      uri.split('/').pop()?.split('?')[0] ||
      'Picked audio';

    return {
      fileSource,
      label: name,
      channelId,
    };
  } catch (e) {
    if (isPickCanceled(e)) {
      return null;
    }
    throw e;
  }
}

export function resolveBundledCodecSource(
  format: CodecAssetFormat
): FileioInputSource {
  return {
    fileSource: fileSourceFromBundledCodecFormat(format),
    label: sampleLabel({ kind: 'codec', format }),
    channelId: Platform.OS === 'android' ? 'app_apkAsset' : 'app_files',
    bundledPath: TEST_CODEC_FILES[format],
  };
}

export function resolveBundledWavLegacy(): FileioInputSource {
  return {
    fileSource: fileSourceFromBundledPath(TEST_AUDIO_FILES.EN_1),
    label: sampleLabel({ kind: 'legacy' }),
    channelId: Platform.OS === 'android' ? 'app_apkAsset' : 'app_files',
    bundledPath: TEST_AUDIO_FILES.EN_1,
  };
}
