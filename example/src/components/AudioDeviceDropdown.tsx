import { useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { AudioRouteDevice } from '../utils/audioDevices';

type AudioDeviceDropdownProps = {
  label: string;
  devices: AudioRouteDevice[];
  selectedDeviceId: string | null;
  onSelectDeviceId: (deviceId: string | null) => void;
  disabled?: boolean;
  defaultLabel?: string;
};

function buildDeviceMeta(device: AudioRouteDevice): string {
  const tags: string[] = [];
  if (device.selected) tags.push('active');
  if (device.default) tags.push('default');
  if (!device.canSelect) tags.push('read-only');
  return tags.length > 0 ? `${device.kind} | ${tags.join(', ')}` : device.kind;
}

export function AudioDeviceDropdown({
  label,
  devices,
  selectedDeviceId,
  onSelectDeviceId,
  disabled = false,
  defaultLabel = 'System default',
}: AudioDeviceDropdownProps) {
  const [open, setOpen] = useState(false);

  const selectableDevices = useMemo(
    () =>
      devices.filter(
        (device) => device.canSelect || device.selected || device.default
      ),
    [devices]
  );

  const selectedDevice = useMemo(
    () =>
      selectedDeviceId
        ? selectableDevices.find((device) => device.id === selectedDeviceId) ??
          null
        : null,
    [selectedDeviceId, selectableDevices]
  );

  const activeDevice = useMemo(
    () => selectableDevices.find((device) => device.selected) ?? null,
    [selectableDevices]
  );

  const triggerText = selectedDevice ? selectedDevice.name : defaultLabel;
  const activeHint =
    !selectedDevice && activeDevice ? `Active route: ${activeDevice.name}` : '';

  return (
    <View style={styles.wrapper}>
      <Text style={styles.label}>{label}</Text>
      <TouchableOpacity
        style={[styles.trigger, disabled && styles.triggerDisabled]}
        onPress={() => setOpen(true)}
        disabled={disabled}
      >
        <Text style={styles.triggerText} numberOfLines={1}>
          {triggerText}
        </Text>
        <Text style={styles.chevron}>v</Text>
      </TouchableOpacity>
      {activeHint ? <Text style={styles.hint}>{activeHint}</Text> : null}

      <Modal
        visible={open}
        animationType="fade"
        transparent
        onRequestClose={() => setOpen(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.menu} onPress={() => {}}>
            <Text style={styles.menuTitle}>{label}</Text>
            <ScrollView style={styles.list}>
              <TouchableOpacity
                style={[
                  styles.option,
                  selectedDeviceId == null && styles.optionActive,
                ]}
                onPress={() => {
                  onSelectDeviceId(null);
                  setOpen(false);
                }}
              >
                <Text
                  style={[
                    styles.optionText,
                    selectedDeviceId == null && styles.optionTextActive,
                  ]}
                >
                  {defaultLabel}
                </Text>
                <Text style={styles.optionMeta}>Use OS routing decision</Text>
              </TouchableOpacity>

              {selectableDevices.map((device) => {
                const isActive = selectedDeviceId === device.id;
                return (
                  <TouchableOpacity
                    key={device.id}
                    style={[styles.option, isActive && styles.optionActive]}
                    onPress={() => {
                      onSelectDeviceId(device.id);
                      setOpen(false);
                    }}
                    disabled={!device.canSelect && !device.selected}
                  >
                    <Text
                      style={[
                        styles.optionText,
                        isActive && styles.optionTextActive,
                      ]}
                      numberOfLines={1}
                    >
                      {device.name}
                    </Text>
                    <Text style={styles.optionMeta}>
                      {buildDeviceMeta(device)}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <TouchableOpacity
              style={styles.closeButton}
              onPress={() => setOpen(false)}
            >
              <Text style={styles.closeButtonText}>Close</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    gap: 6,
    marginBottom: 10,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: '#555',
  },
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 10,
    backgroundColor: '#f8fafc',
    paddingVertical: 11,
    paddingHorizontal: 12,
    gap: 10,
  },
  triggerDisabled: {
    opacity: 0.45,
  },
  triggerText: {
    flex: 1,
    minWidth: 0,
    fontSize: 14,
    color: '#1f2937',
  },
  chevron: {
    fontSize: 12,
    color: '#4b5563',
    fontWeight: '700',
  },
  hint: {
    fontSize: 12,
    color: '#6b7280',
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 30,
  },
  menu: {
    maxHeight: '70%',
    borderRadius: 14,
    backgroundColor: '#fff',
    paddingTop: 14,
    paddingBottom: 10,
    overflow: 'hidden',
  },
  menuTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111827',
    paddingHorizontal: 14,
    marginBottom: 6,
  },
  list: {
    maxHeight: 360,
  },
  option: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e7eb',
  },
  optionActive: {
    backgroundColor: '#e8f1ff',
  },
  optionText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
  },
  optionTextActive: {
    color: '#0b5ed7',
  },
  optionMeta: {
    marginTop: 2,
    fontSize: 12,
    color: '#6b7280',
  },
  closeButton: {
    marginTop: 6,
    alignSelf: 'center',
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  closeButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#0b5ed7',
  },
});
