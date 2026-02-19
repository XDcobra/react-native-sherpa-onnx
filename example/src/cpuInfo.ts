import { NativeModules, Platform } from 'react-native';

type NativeCpuInfo = {
  getCpuCoreCount: () => Promise<number>;
};

const CpuInfo = NativeModules.CpuInfo as NativeCpuInfo | undefined;

/**
 * Returns the number of CPU cores (from native API).
 * Fallback: 2 if the native module is unavailable (e.g. in tests or unsupported).
 */
export async function getCpuCoreCount(): Promise<number> {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') {
    return 2;
  }
  if (!CpuInfo?.getCpuCoreCount) {
    return 2;
  }
  try {
    const count = await CpuInfo.getCpuCoreCount();
    return typeof count === 'number' && count > 0 ? count : 2;
  } catch {
    return 2;
  }
}
