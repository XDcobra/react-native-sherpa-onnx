import { requireJSI } from '../audiobuffer/jsi';

export function takeVisualizationFrames(transferId: string): ArrayBuffer {
  const id = transferId.trim();
  if (!id) {
    throw new Error(
      'AUDIO_VISUALIZATION_INVALID_TRANSFER_ID: transferId must be a non-empty string'
    );
  }

  const jsi = requireJSI() as {
    takeVisualizationFrames?: (value: string) => ArrayBuffer;
  };

  if (typeof jsi.takeVisualizationFrames !== 'function') {
    throw new Error(
      '[JSI_NOT_INSTALLED] takeVisualizationFrames is not available in SherpaOnnx JSI'
    );
  }

  return jsi.takeVisualizationFrames(id);
}
