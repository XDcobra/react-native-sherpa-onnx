import {
  isDetectionSource,
  type DetectedModelEntry,
  type DetectionSource,
} from '../types/modelDetect';

export type DetectModelPathsMap = Readonly<Record<string, string>>;

export function readNonEmptyDetectPathsMap(
  raw: unknown
): DetectModelPathsMap | undefined {
  if (raw == null || typeof raw !== 'object') {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && value.trim().length > 0) {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function readDetectionSources(raw: unknown): DetectionSource[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const sources: DetectionSource[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string' && isDetectionSource(entry)) {
      sources.push(entry);
    }
  }
  return sources;
}

export function readDetectedModels(raw: unknown): DetectedModelEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const models: DetectedModelEntry[] = [];
  for (const entry of raw) {
    if (
      entry != null &&
      typeof entry === 'object' &&
      typeof (entry as { type?: unknown }).type === 'string' &&
      typeof (entry as { modelDir?: unknown }).modelDir === 'string'
    ) {
      models.push({
        type: (entry as { type: string }).type,
        modelDir: (entry as { modelDir: string }).modelDir,
      });
    }
  }
  return models;
}
