import SherpaOnnx from './NativeSherpaOnnx';

export interface ModelLicense {
  asset_name: string;
  license_type: string;
  commercial_use: 'yes' | 'no' | 'conditional' | 'restricted' | 'unknown';
  confidence: string;
  detection_source: string;
  license_file: string;
}

export async function getModelLicenses(): Promise<ModelLicense[]> {
  const asrPath = 'model_licenses/asr-models-license-status.csv';
  const qnnPath = 'model_licenses/qnn-asr-models-license-status.csv';
  const ttsPath = 'model_licenses/tts-models-license-status.csv';
  const speechEnhancementPath =
    'model_licenses/speech-enhancement-models-license-status.csv';

  const results = await Promise.allSettled([
    SherpaOnnx.readAssetFileAsUtf8(asrPath),
    SherpaOnnx.readAssetFileAsUtf8(qnnPath),
    SherpaOnnx.readAssetFileAsUtf8(ttsPath),
    SherpaOnnx.readAssetFileAsUtf8(speechEnhancementPath),
  ]);

  const [asrResult, qnnResult, ttsResult, enhancementResult] = results;

  const licenses: ModelLicense[] = [];

  if (asrResult.status === 'fulfilled') {
    licenses.push(...parseCsv(asrResult.value));
  } else {
    console.warn(
      `[SherpaOnnx] Failed to load ASR model licenses: ${asrResult.reason}`
    );
  }

  if (qnnResult.status === 'fulfilled') {
    licenses.push(...parseCsv(qnnResult.value));
  } else {
    console.warn(
      `[SherpaOnnx] Failed to load QNN model licenses: ${qnnResult.reason}`
    );
  }

  if (ttsResult.status === 'fulfilled') {
    licenses.push(...parseCsv(ttsResult.value));
  } else {
    console.warn(
      `[SherpaOnnx] Failed to load TTS model licenses: ${ttsResult.reason}`
    );
  }

  if (enhancementResult.status === 'fulfilled') {
    licenses.push(...parseCsv(enhancementResult.value));
  } else {
    console.warn(
      `[SherpaOnnx] Failed to load speech enhancement model licenses: ${enhancementResult.reason}`
    );
  }

  return licenses;
}

function parseCsv(csvString: string): ModelLicense[] {
  const lines = csvString.split(/\r?\n/);
  if (lines.length === 0) {
    return [];
  }

  // The first line is the header
  const headerLine = lines[0];
  if (!headerLine) return [];

  const headers = headerLine.split(',').map((h) => h.trim());

  const results: ModelLicense[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.trim() === '') continue;

    // The CSV has 6 columns: asset_name, license_type, commercial_use,
    // confidence, detection_source, license_file.  The last column
    // (license_file) may itself contain commas (e.g. URLs with query strings),
    // so split into at most 6 parts and join any excess back into the last field.
    const COLUMN_COUNT = 6;
    const rawParts = line.split(',');
    const parts =
      rawParts.length <= COLUMN_COUNT
        ? rawParts
        : [
            ...rawParts.slice(0, COLUMN_COUNT - 1),
            rawParts.slice(COLUMN_COUNT - 1).join(','),
          ];

    const entry: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      const header = headers[j];
      if (header) {
        entry[header] = (parts[j] ?? '').trim();
      }
    }

    if (entry.asset_name) {
      results.push(entry as unknown as ModelLicense);
    }
  }

  return results;
}
