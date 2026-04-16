import {
  listAvailableOutputDevices,
  listAvailableInputDevices,
  type PipelineAudioDeviceInfo,
} from 'react-native-sherpa-onnx/audio';

export type AudioRouteDevice = {
  id: string;
  name: string;
  kind: string;
  selected: boolean;
  default: boolean;
  canSelect: boolean;
};

function dedupeDevices(devices: AudioRouteDevice[]): AudioRouteDevice[] {
  const seen = new Set<string>();
  return devices.filter((device) => {
    if (seen.has(device.id)) {
      return false;
    }
    seen.add(device.id);
    return true;
  });
}

function normalizeDevice(device: PipelineAudioDeviceInfo): AudioRouteDevice {
  return {
    id: device.id,
    name: device.name,
    kind: device.kind,
    selected: Boolean(device.selected),
    default: Boolean(device.default),
    canSelect: Boolean(device.canSelect),
  };
}

export async function fetchInputDevices(): Promise<AudioRouteDevice[]> {
  try {
    const listed = await listAvailableInputDevices();
    return dedupeDevices(listed.map(normalizeDevice));
  } catch {
    return [];
  }
}

export async function fetchOutputDevices(): Promise<AudioRouteDevice[]> {
  try {
    const listed = await listAvailableOutputDevices();
    return dedupeDevices(listed.map(normalizeDevice));
  } catch {
    return [];
  }
}

export function keepValidDeviceSelection(
  currentDeviceId: string | null,
  availableDevices: AudioRouteDevice[]
): string | null {
  if (!currentDeviceId) {
    return null;
  }

  return availableDevices.some((device) => device.id === currentDeviceId)
    ? currentDeviceId
    : null;
}
