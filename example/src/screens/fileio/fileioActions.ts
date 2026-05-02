import {
  pick,
  types,
  isErrorWithCode,
  errorCodes,
} from '@react-native-documents/picker';
import type { FileDestination } from 'react-native-sherpa-onnx/fileio';

/** Matches the “Audio source” cards on {@link FileIOScreen}. */
export type AudioSourceChoice = 'example' | 'audioBuffer';

/** Payload when the user taps Copy on the File I/O screen. */
export type FileioCopyInput = {
  /** Selected discriminant from {@link FileDestination}. */
  destinationKind: FileDestination['kind'];
  /** Example clip vs pipeline buffer. */
  audioSource: AudioSourceChoice;
};

/**
 * Invoked when the user presses **Copy** on the File I/O screen.
 * Wire actual copy / encoding / clipboard behavior here.
 */
export async function runFileioCopy(_input: FileioCopyInput): Promise<void> {
  // Implement copy / save / clipboard flow here.
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
