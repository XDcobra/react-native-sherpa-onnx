import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  getDeviceProviderSnapshot,
  refreshCompiledProviders,
  refreshCoreMlSupport,
  refreshNnapiSupport,
  refreshQnnSupport,
  refreshXnnpackSupport,
  subscribeDeviceProviders,
  warmDeviceProviders,
  type DeviceProviderSnapshot,
  type DeviceProviderStatus,
} from '../utils/deviceExecutionProviders';

export type DeviceProvidersContextValue = {
  snapshot: DeviceProviderSnapshot;
  selectableApiIds: string[];
  status: DeviceProviderStatus;
  refreshCompiled: () => Promise<void>;
  refreshQnn: () => Promise<void>;
  refreshNnapi: () => Promise<void>;
  refreshXnnpack: () => Promise<void>;
  refreshCoreMl: () => Promise<void>;
};

const DeviceProvidersContext =
  createContext<DeviceProvidersContextValue | null>(null);

export function DeviceProvidersProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<DeviceProviderSnapshot>(() =>
    getDeviceProviderSnapshot()
  );

  useEffect(() => {
    const unsubscribe = subscribeDeviceProviders(setSnapshot);
    warmDeviceProviders().catch(() => {
      // Fail-soft: cache module never throws; ignore anyway.
    });
    return unsubscribe;
  }, []);

  const refreshCompiled = useCallback(async () => {
    await refreshCompiledProviders();
  }, []);

  const refreshQnn = useCallback(async () => {
    await refreshQnnSupport();
  }, []);

  const refreshNnapi = useCallback(async () => {
    await refreshNnapiSupport();
  }, []);

  const refreshXnnpack = useCallback(async () => {
    await refreshXnnpackSupport();
  }, []);

  const refreshCoreMl = useCallback(async () => {
    await refreshCoreMlSupport();
  }, []);

  const value = useMemo<DeviceProvidersContextValue>(
    () => ({
      snapshot,
      selectableApiIds:
        snapshot.selectableApiIds.length > 0
          ? snapshot.selectableApiIds
          : ['cpu'],
      status: snapshot.status,
      refreshCompiled,
      refreshQnn,
      refreshNnapi,
      refreshXnnpack,
      refreshCoreMl,
    }),
    [
      snapshot,
      refreshCompiled,
      refreshQnn,
      refreshNnapi,
      refreshXnnpack,
      refreshCoreMl,
    ]
  );

  return (
    <DeviceProvidersContext.Provider value={value}>
      {children}
    </DeviceProvidersContext.Provider>
  );
}

export function useDeviceProviders(): DeviceProvidersContextValue {
  const ctx = useContext(DeviceProvidersContext);
  if (!ctx) {
    throw new Error(
      'useDeviceProviders must be used within DeviceProvidersProvider'
    );
  }
  return ctx;
}
