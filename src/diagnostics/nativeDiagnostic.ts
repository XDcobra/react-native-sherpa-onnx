import SherpaOnnx from '../NativeSherpaOnnx';

export type NativeDiagnosticEntry = {
  seq: number;
  monotonicMs: number;
  tid: number;
  threadName: string;
  domain: string;
  phase: string;
  detail: string;
};

export type NativeDiagnosticSnapshot = {
  enabled: boolean;
  signalHandlerInstalled: boolean;
  entries: NativeDiagnosticEntry[];
};

export function parseNativeDiagnosticSnapshot(
  json: string
): NativeDiagnosticSnapshot {
  const raw = JSON.parse(json) as NativeDiagnosticSnapshot;
  return {
    enabled: Boolean(raw.enabled),
    signalHandlerInstalled: Boolean(raw.signalHandlerInstalled),
    entries: Array.isArray(raw.entries) ? raw.entries : [],
  };
}

export async function getNativeDiagnosticSnapshot(): Promise<NativeDiagnosticSnapshot> {
  const json = await SherpaOnnx.getNativeDiagnosticSnapshot();
  return parseNativeDiagnosticSnapshot(json);
}

export async function configureNativeDiagnostics(options?: {
  enabled?: boolean;
  installSignalHandler?: boolean;
}): Promise<void> {
  await SherpaOnnx.configureNativeDiagnostics(options ?? {});
}
