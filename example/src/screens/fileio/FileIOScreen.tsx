import { useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import type { FileDestination } from 'react-native-sherpa-onnx/fileio';
import {
  type AudioSourceChoice,
  openFileioDocumentPicker,
  runFileioCopy,
} from './fileioActions';

/** Every discriminant of {@link FileDestination} supported by the SDK. */
const FILE_DESTINATION_OPTIONS: {
  kind: FileDestination['kind'];
  label: string;
  hint: string;
}[] = [
  { kind: 'fs', label: 'fs', hint: 'Absolute filesystem path' },
  { kind: 'app', label: 'app', hint: 'App sandbox (base + relative path)' },
  {
    kind: 'contentUri',
    label: 'contentUri',
    hint: 'Single content:// document',
  },
  {
    kind: 'contentTree',
    label: 'contentTree',
    hint: 'SAF tree URI + filename + mime (Android)',
  },
  {
    kind: 'securityScoped',
    label: 'securityScoped',
    hint: 'Security-scoped URL (typically iOS)',
  },
];

/** Sandbox for isolating FileDestination / saveAudioAsFile behavior. */
export default function FileIOScreen() {
  const [kind, setKind] = useState<FileDestination['kind']>('fs');
  const [menuOpen, setMenuOpen] = useState(false);
  const [audioSource, setAudioSource] = useState<AudioSourceChoice>('example');

  const selected = FILE_DESTINATION_OPTIONS.find((o) => o.kind === kind)!;

  return (
    <SafeAreaView style={styles.root} edges={['bottom', 'left', 'right']}>
      <View style={styles.dropdownRow}>
        <Text style={styles.dropdownLabel}>FileDestination</Text>
        <Pressable
          style={styles.dropdownTrigger}
          onPress={() => setMenuOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="Choose FileDestination kind"
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

      <View style={styles.sourceSection}>
        <Text style={styles.dropdownLabel}>Audio source</Text>
        <View style={styles.sourceCardsRow}>
          <Pressable
            style={[
              styles.sourceCard,
              audioSource === 'example' && styles.sourceCardActive,
            ]}
            onPress={() => setAudioSource('example')}
            accessibilityRole="button"
            accessibilityState={{ selected: audioSource === 'example' }}
          >
            <Ionicons
              name="musical-notes-outline"
              size={24}
              color={audioSource === 'example' ? '#007AFF' : '#8E8E93'}
            />
            <Text
              style={[
                styles.sourceCardTitle,
                audioSource === 'example' && styles.sourceCardTitleActive,
              ]}
            >
              Example audio
            </Text>
            <Text style={styles.sourceCardHint}>Bundled / demo sample</Text>
          </Pressable>
          <Pressable
            style={[
              styles.sourceCard,
              audioSource === 'audioBuffer' && styles.sourceCardActive,
            ]}
            onPress={() => setAudioSource('audioBuffer')}
            accessibilityRole="button"
            accessibilityState={{ selected: audioSource === 'audioBuffer' }}
          >
            <Ionicons
              name="layers-outline"
              size={24}
              color={audioSource === 'audioBuffer' ? '#007AFF' : '#8E8E93'}
            />
            <Text
              style={[
                styles.sourceCardTitle,
                audioSource === 'audioBuffer' && styles.sourceCardTitleActive,
              ]}
            >
              AudioBuffer
            </Text>
            <Text style={styles.sourceCardHint}>
              Automatically created example audio buffer
            </Text>
          </Pressable>
        </View>
      </View>

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
            <Text style={styles.modalTitle}>FileDestination kind</Text>
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

      <View style={styles.body} />

      <View style={styles.footer}>
        <Pressable
          style={({ pressed }) => [
            styles.copyButton,
            pressed && styles.copyButtonPressed,
          ]}
          onPress={() => {
            runFileioCopy({
              destinationKind: kind,
              audioSource,
            }).catch(() => {});
          }}
          accessibilityRole="button"
          accessibilityLabel="Copy"
        >
          <Ionicons name="copy-outline" size={20} color="#FFFFFF" />
          <Text style={styles.copyButtonText}>Copy</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [
            styles.openPickerButton,
            pressed && styles.openPickerButtonPressed,
          ]}
          onPress={() => {
            openFileioDocumentPicker().catch(() => {});
          }}
          accessibilityRole="button"
          accessibilityLabel="Open document picker"
        >
          <Ionicons name="folder-open-outline" size={20} color="#3A3A3C" />
          <Text style={styles.openPickerButtonText}>Open document picker</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#F2F2F7',
  },
  dropdownRow: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#C6C6C8',
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
  sourceSection: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 14,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#C6C6C8',
  },
  sourceCardsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  sourceCard: {
    flex: 1,
    minHeight: 100,
    backgroundColor: '#F2F2F7',
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderWidth: 2,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sourceCardActive: {
    borderColor: '#007AFF',
    backgroundColor: 'rgba(0, 122, 255, 0.06)',
  },
  sourceCardTitle: {
    marginTop: 8,
    fontSize: 15,
    fontWeight: '600',
    color: '#3A3A3C',
    textAlign: 'center',
  },
  sourceCardTitleActive: {
    color: '#007AFF',
  },
  sourceCardHint: {
    marginTop: 4,
    fontSize: 11,
    color: '#8E8E93',
    textAlign: 'center',
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
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E5E5EA',
  },
  optionRowActive: {
    backgroundColor: 'rgba(0, 122, 255, 0.08)',
  },
  optionTextCol: {
    flex: 1,
    marginRight: 8,
  },
  optionKind: {
    fontSize: 16,
    fontWeight: '500',
    color: '#000000',
  },
  optionKindActive: {
    color: '#007AFF',
  },
  optionHint: {
    fontSize: 13,
    color: '#8E8E93',
    marginTop: 2,
  },
  body: {
    flex: 1,
  },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
    backgroundColor: '#FFFFFF',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#C6C6C8',
  },
  copyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#007AFF',
    borderRadius: 12,
    paddingVertical: 14,
  },
  copyButtonPressed: {
    opacity: 0.85,
  },
  copyButtonText: {
    fontSize: 17,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  openPickerButton: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#E5E5EA',
    borderRadius: 12,
    paddingVertical: 14,
  },
  openPickerButtonPressed: {
    opacity: 0.85,
  },
  openPickerButtonText: {
    fontSize: 17,
    fontWeight: '600',
    color: '#3A3A3C',
  },
});
