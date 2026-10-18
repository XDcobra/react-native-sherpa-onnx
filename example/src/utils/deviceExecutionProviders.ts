/**
 * In-memory cache of ORT execution-provider probes for the example app.
 * Warm once at app start; Settings refresh re-probes individually.
 * All public APIs are fail-soft (never throw to callers).
 */

import type { AccelerationSupport } from 'react-native-sherpa-onnx/provider';
import {
  getAvailableProviders,
  getCoreMlSupport,
  getNnapiSupport,
  getQnnSupport,
  getXnnpackSupport,
} from 'react-native-sherpa-onnx/provider';

export type AccelProviderId = 'qnn' | 'nnapi' | 'xnnpack' | 'coreml';

export type DeviceProviderSupports = {
  qnn: AccelerationSupport | null;
  nnapi: AccelerationSupport | null;
  xnnpack: AccelerationSupport | null;
  coreml: AccelerationSupport | null;
};

export type DeviceProviderErrors = {
  compiled?: string;
  qnn?: string;
  nnapi?: string;
  xnnpack?: string;
  coreml?: string;
};

export type DeviceProviderStatus = 'idle' | 'loading' | 'ready';

export type DeviceProviderSnapshot = {
  status: DeviceProviderStatus;
  compiledProviders: string[];
  supports: DeviceProviderSupports;
  errors: DeviceProviderErrors;
  /** Lower-case API ids for create* `provider` options. Always includes `cpu`. */
  selectableApiIds: string[];
};

type Listener = (snapshot: DeviceProviderSnapshot) => void;

const ORT_NAME_TO_API_ID: Readonly<Record<string, string>> = {
  CPUExecutionProvider: 'cpu',
  CPU: 'cpu',
  NnapiExecutionProvider: 'nnapi',
  NNAPI: 'nnapi',
  QNNExecutionProvider: 'qnn',
  QNN: 'qnn',
  XnnpackExecutionProvider: 'xnnpack',
  XNNPACK: 'xnnpack',
  CoreMLExecutionProvider: 'coreml',
  CoreML: 'coreml',
};

const ACCEL_IDS: readonly AccelProviderId[] = [
  'coreml',
  'nnapi',
  'qnn',
  'xnnpack',
];

function ortNameToApiId(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const direct = ORT_NAME_TO_API_ID[trimmed];
  if (direct) return direct;
  const lower = trimmed.toLowerCase();
  if (lower.includes('cpu')) return 'cpu';
  if (lower.includes('nnapi')) return 'nnapi';
  if (lower.includes('qnn')) return 'qnn';
  if (lower.includes('xnnpack')) return 'xnnpack';
  if (lower.includes('coreml')) return 'coreml';
  return null;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message;
  if (typeof err === 'string' && err.trim()) return err;
  return 'Unknown error';
}

function emptySupports(): DeviceProviderSupports {
  return { qnn: null, nnapi: null, xnnpack: null, coreml: null };
}

function buildSelectableApiIds(
  compiledProviders: string[],
  supports: DeviceProviderSupports
): string[] {
  const candidates = new Set<string>(['cpu']);
  for (const name of compiledProviders) {
    const id = ortNameToApiId(name);
    if (id) candidates.add(id);
  }

  const out: string[] = ['cpu'];
  for (const id of ACCEL_IDS) {
    if (!candidates.has(id)) continue;
    if (supports[id]?.canInit) {
      out.push(id);
    }
  }
  return out;
}

function makeSnapshot(
  partial: Omit<DeviceProviderSnapshot, 'selectableApiIds'>
): DeviceProviderSnapshot {
  return {
    ...partial,
    selectableApiIds: buildSelectableApiIds(
      partial.compiledProviders,
      partial.supports
    ),
  };
}

let snapshot: DeviceProviderSnapshot = makeSnapshot({
  status: 'idle',
  compiledProviders: [],
  supports: emptySupports(),
  errors: {},
});

let warmPromise: Promise<DeviceProviderSnapshot> | null = null;
const listeners = new Set<Listener>();

function setSnapshot(next: DeviceProviderSnapshot): DeviceProviderSnapshot {
  snapshot = next;
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch {
      // Ignore subscriber errors so one bad consumer cannot break others.
    }
  }
  return snapshot;
}

function patchSnapshot(
  patch: Partial<
    Omit<DeviceProviderSnapshot, 'selectableApiIds' | 'supports' | 'errors'>
  > & {
    supports?: Partial<DeviceProviderSupports>;
    errors?: DeviceProviderErrors;
  }
): DeviceProviderSnapshot {
  return setSnapshot(
    makeSnapshot({
      status: patch.status ?? snapshot.status,
      compiledProviders: patch.compiledProviders ?? snapshot.compiledProviders,
      supports: { ...snapshot.supports, ...(patch.supports ?? {}) },
      errors: patch.errors ?? snapshot.errors,
    })
  );
}

async function probeCompiled(): Promise<{
  compiledProviders: string[];
  error?: string;
}> {
  try {
    const list = await getAvailableProviders();
    return {
      compiledProviders: Array.isArray(list) ? list.map(String) : [],
    };
  } catch (err) {
    return { compiledProviders: [], error: errorMessage(err) };
  }
}

async function probeAccel(id: AccelProviderId): Promise<{
  support: AccelerationSupport | null;
  error?: string;
}> {
  try {
    const probe =
      id === 'qnn'
        ? getQnnSupport
        : id === 'nnapi'
        ? getNnapiSupport
        : id === 'xnnpack'
        ? getXnnpackSupport
        : getCoreMlSupport;
    const support = await probe();
    return { support };
  } catch (err) {
    return { support: null, error: errorMessage(err) };
  }
}

/**
 * Run compiled + all accel probes once. Concurrent warm calls share one promise.
 * Never throws.
 */
export async function warmDeviceProviders(): Promise<DeviceProviderSnapshot> {
  if (snapshot.status === 'ready' && warmPromise == null) {
    return snapshot;
  }
  if (warmPromise) {
    return warmPromise;
  }

  warmPromise = (async () => {
    patchSnapshot({ status: 'loading' });

    const [compiledResult, ...accelResults] = await Promise.all([
      probeCompiled(),
      ...ACCEL_IDS.map((id) => probeAccel(id).then((r) => ({ id, ...r }))),
    ]);

    const supports = emptySupports();
    const errors: DeviceProviderErrors = {};
    if (compiledResult.error) {
      errors.compiled = compiledResult.error;
    }
    for (const row of accelResults) {
      supports[row.id] = row.support;
      if (row.error) {
        errors[row.id] = row.error;
      }
    }

    return setSnapshot(
      makeSnapshot({
        status: 'ready',
        compiledProviders: compiledResult.compiledProviders,
        supports,
        errors,
      })
    );
  })()
    .catch(() =>
      // Absolute last resort — still never throw.
      setSnapshot(
        makeSnapshot({
          status: 'ready',
          compiledProviders: [],
          supports: emptySupports(),
          errors: { compiled: 'Provider warm-up failed' },
        })
      )
    )
    .finally(() => {
      warmPromise = null;
    });

  return warmPromise;
}

export function getDeviceProviderSnapshot(): DeviceProviderSnapshot {
  return snapshot;
}

export function subscribeDeviceProviders(listener: Listener): () => void {
  listeners.add(listener);
  try {
    listener(snapshot);
  } catch {
    // ignore
  }
  return () => {
    listeners.delete(listener);
  };
}

export async function refreshCompiledProviders(): Promise<DeviceProviderSnapshot> {
  const result = await probeCompiled();
  const errors: DeviceProviderErrors = { ...snapshot.errors };
  if (result.error) {
    errors.compiled = result.error;
  } else {
    delete errors.compiled;
  }
  return patchSnapshot({
    status: 'ready',
    compiledProviders: result.compiledProviders,
    errors,
  });
}

async function refreshAccel(
  id: AccelProviderId
): Promise<DeviceProviderSnapshot> {
  const result = await probeAccel(id);
  const errors: DeviceProviderErrors = { ...snapshot.errors };
  if (result.error) {
    errors[id] = result.error;
  } else {
    delete errors[id];
  }
  return patchSnapshot({
    status: 'ready',
    supports: { [id]: result.support },
    errors,
  });
}

export function refreshQnnSupport(): Promise<DeviceProviderSnapshot> {
  return refreshAccel('qnn');
}

export function refreshNnapiSupport(): Promise<DeviceProviderSnapshot> {
  return refreshAccel('nnapi');
}

export function refreshXnnpackSupport(): Promise<DeviceProviderSnapshot> {
  return refreshAccel('xnnpack');
}

export function refreshCoreMlSupport(): Promise<DeviceProviderSnapshot> {
  return refreshAccel('coreml');
}

/**
 * Selectable API provider ids. Warms cache if still idle.
 * Never throws; falls back to `['cpu']`.
 */
export async function listDeviceSupportedProviders(): Promise<string[]> {
  try {
    if (snapshot.status === 'idle') {
      await warmDeviceProviders();
    }
    const ids = snapshot.selectableApiIds;
    return ids.length > 0 ? ids : ['cpu'];
  } catch {
    return ['cpu'];
  }
}
