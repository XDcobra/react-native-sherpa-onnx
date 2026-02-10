import { DeviceEventEmitter } from 'react-native';
import SherpaOnnx from '../NativeSherpaOnnx';

export type ExtractProgressEvent = {
  bytes: number;
  totalBytes: number;
  percent: number;
};

type ExtractResult = {
  success: boolean;
  path?: string;
  reason?: string;
};

export async function extractTarBz2(
  sourcePath: string,
  targetPath: string,
  force = true,
  onProgress?: (event: ExtractProgressEvent) => void
): Promise<ExtractResult> {
  let subscription: { remove: () => void } | null = null;

  if (onProgress) {
    subscription = DeviceEventEmitter.addListener(
      'extractTarBz2Progress',
      onProgress
    );
  }

  try {
    return await SherpaOnnx.extractTarBz2(sourcePath, targetPath, force);
  } finally {
    subscription?.remove();
  }
}
