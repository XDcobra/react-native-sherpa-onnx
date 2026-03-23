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
  const ttsPath = 'model_licenses/tts-models-license-status.csv';

  try {
    const [asrCsvContent, ttsCsvContent] = await Promise.all([
      SherpaOnnx.readAssetFileAsUtf8(asrPath),
      SherpaOnnx.readAssetFileAsUtf8(ttsPath),
    ]);

    const asrLicenses = parseCsv(asrCsvContent);
    const ttsLicenses = parseCsv(ttsCsvContent);

    return [...asrLicenses, ...ttsLicenses];
  } catch (error) {
    console.warn(`[SherpaOnnx] Failed to load merged model licenses: ${error}`);
    return [];
  }
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

    const values = line.split(',').map((v) => v.trim());

    // Basic protection against malformed lines (assuming no commas in values)
    const entry: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      const header = headers[j];
      if (header) {
        entry[header] = values[j] || '';
      }
    }

    if (entry['asset_name']) {
      results.push(entry as unknown as ModelLicense);
    }
  }

  return results;
}
