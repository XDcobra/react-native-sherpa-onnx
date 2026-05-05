import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import type {
  AudioOutputFormat,
  AudioSaveInput,
  SaveAudioOptions,
} from 'react-native-sherpa-onnx/audio';
import { saveAudioAsFile } from 'react-native-sherpa-onnx/audio';
import type {
  FileDestination,
  ResolvedFileRef,
} from 'react-native-sherpa-onnx/fileio';
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

/**
 * Props for {@link AudioSaveDestinationPicker}.
 *
 * Minimal example:
 * ```tsx
 * <AudioSaveDestinationPicker
 *   audioInput={bufferId}
 *   filename="output.wav"
 *   onSaveComplete={(result) => {
 *     Alert.alert('Saved', formatResolvedLocation(result));
 *   }}
 * />
 * ```
 */
export type AudioSaveDestinationPickerProps = {
  /** The audio to save: {@link AudioSaveInput} (buffer ID, FileSource, etc). */
  audioInput: AudioSaveInput;
  /** Base filename (without path). Used by pickers to generate unique filenames. */
  filename: string;
  /** Audio format (default: 'wav'). */
  format?: AudioOutputFormat;
  /** SDK save options (default: { outputSampleRateHz: 16000 }). */
  options?: SaveAudioOptions;
  /** If true, picker button is disabled. */
  disabled?: boolean;
  /** Initial row in the destination dropdown (default: `'fs'`). */
  defaultDestinationKind?: FileDestination['kind'];
  /** Callback when save completes successfully. */
  onSaveComplete?: (result: ResolvedFileRef) => void;
  /** Callback when save fails. */
  onError?: (error: Error) => void;
};

/** Matches all {@link FileDestination} discriminants supported by the SDK. */
const FILE_DESTINATION_OPTIONS: {
  kind: FileDestination['kind'];
  label: string;
  hint: string;
}[] = [
  { kind: 'fs', label: 'fs', hint: 'Absolute filesystem path' },
  { kind: 'app', label: 'app', hint: 'App sandbox (documents folder)' },
  {
    kind: 'contentUri',
    label: 'contentUri',
    hint: 'Single content:// document (Android save dialog)',
  },
  {
    kind: 'contentTree',
    label: 'contentTree',
    hint: 'SAF tree URI + filename + mime (Android)',
  },
  {
    kind: 'securityScoped',
    label: 'securityScoped',
    hint: 'Security-scoped URL (iOS bookmark)',
  },
];

function mimeTypeForAudioFormat(format: AudioOutputFormat): string {
  const f = String(format).toLowerCase();
  switch (f) {
    case 'wav':
      return 'audio/wav';
    case 'mp3':
      return 'audio/mpeg';
    case 'flac':
      return 'audio/flac';
    case 'aac':
    case 'm4a':
      return 'audio/mp4';
    case 'opus':
    case 'ogg':
      return 'audio/ogg';
    case 'webm':
      return 'audio/webm';
    default:
      return 'application/octet-stream';
  }
}

function isPickCanceled(err: unknown): boolean {
  if (isErrorWithCode(err) && err.code === errorCodes.OPERATION_CANCELED) {
    return true;
  }
  return false;
}

/**
 * Build a FileDestination for `fs` or `app` without user interaction.
 * Both get a unique timestamped filename.
 */
async function fixedDestinationForKind(
  kind: 'fs' | 'app',
  filename: string
): Promise<FileDestination> {
  const basename = filename.replace(/\.[^/.]+$/, ''); // remove extension
  const ext = filename.match(/\.[^/.]+$/)?.[0] || '.wav';
  const uniqueName = `${basename}_${Date.now()}${ext}`;

  if (kind === 'fs') {
    const exportDir = `${DocumentDirectoryPath}/SherpaOnnxAudio/exports`;
    await mkdir(exportDir, { NSURLIsExcludedFromBackupKey: false }).catch(
      () => {}
    );
    return { kind: 'fs', path: `${exportDir}/${uniqueName}` };
  }

  return {
    kind: 'app',
    base: 'documents',
    path: `SherpaOnnxAudio/${uniqueName}`,
  };
}

/**
 * Opens the folder picker and returns a {@link FileDestination}.
 * On Android: converts SAF tree URIs to `contentTree`.
 * On iOS/simulator: converts `file://` URIs to `fs` paths.
 */
async function pickContentTreeDestination(
  filename: string
): Promise<FileDestination> {
  const picked = await pickDirectory({ requestLongTermAccess: false });
  const uri = picked.uri?.trim();
  if (!uri) {
    throw new Error('Folder picker did not return a URI.');
  }

  if (uri.startsWith('content://')) {
    return {
      kind: 'contentTree',
      treeUri: uri,
      filename,
      mimeType: mimeTypeForAudioFormat('wav'), // Use WAV as default MIME
    };
  }

  if (uri.startsWith('file://')) {
    const dir = decodeURI(uri.replace(/^file:\/\//, '')).replace(/\/$/, '');
    return { kind: 'fs', path: `${dir}/${filename}` };
  }

  throw new Error(
    'Folder picker must return content:// (Android SAF) or file:// (iOS).'
  );
}

/**
 * iOS only: opens a security-scoped file picker for audio documents.
 * Returns a {@link FileDestination} with kind `securityScoped`.
 */
async function pickSecurityScopedDestination(): Promise<FileDestination> {
  if (Platform.OS !== 'ios') {
    throw new Error('securityScoped destinations are for iOS only.');
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

/**
 * Android `contentUri` requires a "Save as" dialog. We stage the audio to app cache,
 * then invoke {@link saveDocuments} so the user picks the final location.
 */
async function saveViaStagingAndSaveDocuments(
  input: AudioSaveInput,
  filename: string,
  format: AudioOutputFormat,
  options?: SaveAudioOptions
): Promise<ResolvedFileRef> {
  const stagingRel = `audio-staging/temp_${Date.now()}.wav`;
  const stagingDest: FileDestination = {
    kind: 'app',
    base: 'cache',
    path: stagingRel,
  };

  // Stage to app cache
  const staged = await saveAudioAsFile(input, stagingDest, format, options);
  if (staged.kind !== 'fs') {
    throw new Error('Expected filesystem path from app cache staging.');
  }

  const fsPath = staged.path;
  const sourceUri = encodeURI(
    fsPath.startsWith('file://') ? fsPath : `file://${fsPath}`
  );

  try {
    // Open save dialog
    const responses = await saveDocuments({
      sourceUris: [sourceUri],
      mimeType: mimeTypeForAudioFormat(format),
      fileName: filename,
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
    // Clean up staging file
    await unlink(fsPath).catch(() => {});
  }
}

/**
 * Reusable component: FileDestination dropdown + save button.
 *
 * Handles all 5 FileDestination kinds:
 * - `fs`: Fixed export folder with timestamped filename.
 * - `app`: Fixed app documents folder with timestamped filename.
 * - `contentTree`: Folder picker → SAF tree or file:// path.
 * - `contentUri`: Staging + Android save dialog.
 * - `securityScoped`: iOS security-scoped bookmark picker.
 *
 * Usage:
 * ```tsx
 * const [saving, setSaving] = useState(false);
 *
 * <AudioSaveDestinationPicker
 *   audioInput={myAudioBuffer}
 *   filename="output.wav"
 *   disabled={saving}
 *   onSaveComplete={(result) => {
 *     const location = formatResolvedLocation(result);
 *     Alert.alert('Success', `Saved to ${location}`);
 *   }}
 *   onError={(error) => {
 *     Alert.alert('Error', error.message);
 *   }}
 * />
 * ```
 */
export function AudioSaveDestinationPicker({
  audioInput,
  filename,
  format = 'wav',
  options,
  disabled = false,
  defaultDestinationKind = 'fs',
  onSaveComplete,
  onError,
}: AudioSaveDestinationPickerProps) {
  const [kind, setKind] = useState<FileDestination['kind']>(
    defaultDestinationKind
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const selected = FILE_DESTINATION_OPTIONS.find((o) => o.kind === kind)!;

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      let destination: FileDestination;

      switch (kind) {
        case 'fs':
        case 'app': {
          destination = await fixedDestinationForKind(kind, filename);
          break;
        }
        case 'contentTree': {
          destination = await pickContentTreeDestination(filename);
          break;
        }
        case 'contentUri': {
          // contentUri uses staging + saveDocuments flow
          const result = await saveViaStagingAndSaveDocuments(
            audioInput,
            filename,
            format,
            options
          );
          onSaveComplete?.(result);
          return;
        }
        case 'securityScoped': {
          destination = await pickSecurityScopedDestination();
          break;
        }
      }

      // Save to the resolved destination
      const result = await saveAudioAsFile(
        audioInput,
        destination,
        format,
        options
      );
      onSaveComplete?.(result);
    } catch (err) {
      // Silently ignore user cancellations
      if (isPickCanceled(err)) {
        return;
      }

      const error = err instanceof Error ? err : new Error(String(err));
      onError?.(error);
    } finally {
      setSaving(false);
    }
  }, [audioInput, filename, format, options, kind, onSaveComplete, onError]);

  return (
    <View style={styles.container}>
      {/* Destination Dropdown */}
      <View style={styles.dropdownRow}>
        <Text style={styles.dropdownLabel}>Save to</Text>
        <Pressable
          style={styles.dropdownTrigger}
          onPress={() => setMenuOpen(true)}
          disabled={disabled || saving}
          accessibilityRole="button"
          accessibilityLabel="Choose FileDestination"
        >
          <View style={styles.dropdownTriggerText}>
            <Text style={styles.dropdownKind}>{selected.label}</Text>
            <Text style={styles.dropdownHint} numberOfLines={1}>
              {selected.hint}
            </Text>
          </View>
          <Ionicons name="chevron-down" size={20} color="#007AFF" />
        </Pressable>
      </View>

      {/* Destination Modal */}
      <Modal
        visible={menuOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuOpen(false)}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => setMenuOpen(false)}
        >
          <Pressable
            style={styles.modalSheet}
            onPress={(e) => e.stopPropagation()}
          >
            <Text style={styles.modalTitle}>FileDestination</Text>
            <ScrollView
              style={styles.modalList}
              keyboardShouldPersistTaps="handled"
            >
              {FILE_DESTINATION_OPTIONS.map((opt) => {
                const active = opt.kind === kind;
                return (
                  <Pressable
                    key={opt.kind}
                    style={[styles.optionRow, active && styles.optionRowActive]}
                    onPress={() => {
                      setKind(opt.kind);
                      setMenuOpen(false);
                    }}
                  >
                    <View style={styles.optionTextCol}>
                      <Text
                        style={[
                          styles.optionKind,
                          active && styles.optionKindActive,
                        ]}
                      >
                        {opt.label}
                      </Text>
                      <Text style={styles.optionHint}>{opt.hint}</Text>
                    </View>
                    {active && (
                      <Ionicons name="checkmark" size={22} color="#007AFF" />
                    )}
                  </Pressable>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Save Button */}
      <Pressable
        style={({ pressed }) => [
          styles.saveButton,
          (pressed || saving) && styles.saveButtonPressed,
          (disabled || saving) && styles.saveButtonDisabled,
        ]}
        disabled={disabled || saving}
        onPress={handleSave}
        accessibilityRole="button"
        accessibilityLabel="Save audio"
      >
        {saving ? (
          <ActivityIndicator color="#FFFFFF" size="small" />
        ) : (
          <Ionicons name="save-outline" size={18} color="#FFFFFF" />
        )}
        <Text style={styles.saveButtonText}>{saving ? 'Saving…' : 'Save'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingVertical: 12,
    alignSelf: 'stretch',
    width: '100%',
  },
  dropdownRow: {
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  dropdownLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#8E8E93',
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  dropdownTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#F2F2F7',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: '#E5E5EA',
  },
  dropdownTriggerText: {
    flex: 1,
    marginRight: 8,
  },
  dropdownKind: {
    fontSize: 17,
    fontWeight: '600',
    color: '#000000',
  },
  dropdownHint: {
    fontSize: 13,
    color: '#8E8E93',
    marginTop: 2,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  modalSheet: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    maxHeight: '70%',
    paddingTop: 16,
    paddingBottom: 8,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: '#000000',
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  modalList: {
    maxHeight: 360,
  },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#F2F2F7',
  },
  optionRowActive: {
    backgroundColor: 'rgba(0, 122, 255, 0.06)',
  },
  optionTextCol: {
    flex: 1,
    marginRight: 12,
  },
  optionKind: {
    fontSize: 15,
    fontWeight: '500',
    color: '#3A3A3C',
  },
  optionKindActive: {
    color: '#007AFF',
    fontWeight: '600',
  },
  optionHint: {
    fontSize: 12,
    color: '#8E8E93',
    marginTop: 2,
  },
  saveButton: {
    marginHorizontal: 16,
    marginTop: 12,
    backgroundColor: '#007AFF',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  saveButtonPressed: {
    backgroundColor: '#0051D5',
  },
  saveButtonDisabled: {
    backgroundColor: '#C7C7CC',
    opacity: 0.5,
  },
  saveButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
});
