import {
  DocumentDirectoryPath,
  downloadFile,
  exists,
  mkdir,
  unlink,
  writeFile,
} from '@dr.pogodin/react-native-fs';
import type { DownloadAlignmentModelOptions } from './types';

export const DEFAULT_ALIGNMENT_MODEL_URL =
  'https://huggingface.co/onnx-community/wav2vec2-base-960h-ONNX/resolve/main/onnx/model_int8.onnx';

const ALIGNMENT_BASE_DIR =
  `${DocumentDirectoryPath}/sherpa-onnx/alignment`.replace(/\/+/g, '/');
const ALIGNMENT_MODEL_PATH = `${ALIGNMENT_BASE_DIR}/model.onnx`;
const ALIGNMENT_READY_MARKER_PATH = `${ALIGNMENT_BASE_DIR}/.ready`;

async function removeIfExists(path: string): Promise<void> {
  if (await exists(path)) {
    await unlink(path);
  }
}

async function ensureBaseDir(): Promise<void> {
  await mkdir(ALIGNMENT_BASE_DIR);
}

export async function downloadAlignmentModel(
  options?: DownloadAlignmentModelOptions
): Promise<string> {
  const url = options?.url?.trim() || DEFAULT_ALIGNMENT_MODEL_URL;
  await ensureBaseDir();

  await removeIfExists(ALIGNMENT_READY_MARKER_PATH);
  await removeIfExists(ALIGNMENT_MODEL_PATH);

  try {
    const task = downloadFile({
      fromUrl: url,
      toFile: ALIGNMENT_MODEL_PATH,
      progressDivider: 1,
      progress: ({ bytesWritten, contentLength }) => {
        options?.onProgress?.({ bytesWritten, contentLength });
      },
    });

    const result = await task.promise;
    if (result.statusCode < 200 || result.statusCode >= 300) {
      throw new Error(
        `Failed to download alignment model (status ${result.statusCode}).`
      );
    }

    await writeFile(ALIGNMENT_READY_MARKER_PATH, 'ready', 'utf8');
    return ALIGNMENT_MODEL_PATH;
  } catch (error) {
    await removeIfExists(ALIGNMENT_READY_MARKER_PATH).catch(() => {
      // ignore cleanup errors
    });
    await removeIfExists(ALIGNMENT_MODEL_PATH).catch(() => {
      // ignore cleanup errors
    });

    throw error;
  }
}

export async function isAlignmentModelReady(): Promise<boolean> {
  const [hasModel, hasReadyMarker] = await Promise.all([
    exists(ALIGNMENT_MODEL_PATH),
    exists(ALIGNMENT_READY_MARKER_PATH),
  ]);
  return hasModel && hasReadyMarker;
}

export async function getAlignmentModelPath(): Promise<string | null> {
  return (await isAlignmentModelReady()) ? ALIGNMENT_MODEL_PATH : null;
}

export async function deleteAlignmentModel(): Promise<void> {
  await removeIfExists(ALIGNMENT_READY_MARKER_PATH);
  await removeIfExists(ALIGNMENT_MODEL_PATH);
}
