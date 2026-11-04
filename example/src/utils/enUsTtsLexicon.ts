import { Platform } from 'react-native';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import { resolveFileSourceForModelInit } from 'react-native-sherpa-onnx/detect';
import {
  MainBundlePath,
  copyFile,
  copyFileAssets,
  exists,
  readDir,
} from '@dr.pogodin/react-native-fs';

/** Matches `android/app/src/main/assets/tts/lexicon-en-us.txt` and iOS bundle `tts/lexicon-en-us.txt`. */
const BUNDLED_LEXICON_ASSET = 'tts/lexicon-en-us.txt';

const LEXICON_CAPABLE_TYPES = new Set(['vits', 'matcha', 'kokoro', 'kitten']);

function logFallback(message: string, detail?: Record<string, unknown>): void {
  if (!__DEV__) return;
  if (detail) {
    console.log(`[TtsLexiconFallback] ${message}`, detail);
  } else {
    console.log(`[TtsLexiconFallback] ${message}`);
  }
}

function guessTtsTypeFromModelId(modelId: string): string | null {
  const lower = modelId.toLowerCase();
  if (lower.includes('vits')) return 'vits';
  if (lower.includes('matcha')) return 'matcha';
  if (lower.includes('kokoro')) return 'kokoro';
  if (lower.includes('kitten')) return 'kitten';
  if (lower.includes('piper')) return 'vits';
  return null;
}

function isLexiconFileName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === 'lexicon.txt') return true;
  return lower.startsWith('lexicon-') && lower.endsWith('.txt');
}

async function modelDirHasLexicon(modelDir: string): Promise<boolean> {
  try {
    const entries = await readDir(modelDir);
    return entries.some((entry) => isLexiconFileName(entry.name));
  } catch {
    return false;
  }
}

export function shouldEnsureEnUsTtsLexicon(
  modelId: string,
  detectedModelType?: string | null
): boolean {
  if (
    detectedModelType != null &&
    LEXICON_CAPABLE_TYPES.has(detectedModelType)
  ) {
    return true;
  }
  const fromId = guessTtsTypeFromModelId(modelId);
  return fromId != null && LEXICON_CAPABLE_TYPES.has(fromId);
}

function fileSourcePathHint(source: FileSource): string {
  if (source.kind === 'fs') {
    return source.path;
  }
  if (source.kind === 'app' || source.kind === 'pad') {
    return source.path;
  }
  return '';
}

/**
 * Piper / English VITS packs often omit lexicon after espeak-ng-data was dropped.
 * Copies the app-bundled en-US lexicon into the resolved model directory when missing.
 */
export async function ensureEnUsTtsLexiconInModelDir(
  modelDir: string
): Promise<void> {
  const dir = modelDir.replace(/\/+$/, '');
  if (await modelDirHasLexicon(dir)) {
    logFallback('skip: model dir already has lexicon', { modelDir: dir });
    return;
  }
  const dest = `${dir}/lexicon-en-us.txt`;
  try {
    if (Platform.OS === 'android') {
      await copyFileAssets(BUNDLED_LEXICON_ASSET, dest);
    } else {
      const src = `${MainBundlePath}/${BUNDLED_LEXICON_ASSET}`;
      if (!(await exists(src))) {
        logFallback('skip: bundled lexicon missing in app bundle', { src });
        console.warn(
          '[TtsLexiconFallback] Bundled lexicon missing in app bundle; expected at',
          src
        );
        return;
      }
      await copyFile(src, dest);
    }
    logFallback('copied bundled lexicon-en-us.txt into model dir', {
      modelDir: dir,
      dest,
    });
  } catch (e) {
    logFallback('copy failed', {
      modelDir: dir,
      error: e instanceof Error ? e.message : String(e),
    });
    console.warn(
      '[TtsLexiconFallback] Could not copy bundled lexicon into model dir:',
      e instanceof Error ? e.message : e
    );
  }
}

/**
 * Resolve a {@link FileSource} to a local model dir and copy bundled en-US lexicon when needed.
 * Call before native detect / createTTS for lexicon-capable TTS folders.
 */
export async function ensureEnUsTtsLexiconForFileSource(
  source: FileSource,
  modelId?: string,
  detectedModelType?: string | null
): Promise<void> {
  const hint = (modelId ?? fileSourcePathHint(source)).trim();
  if (!shouldEnsureEnUsTtsLexicon(hint, detectedModelType)) {
    logFallback('skip: model kind does not need en-US lexicon fallback', {
      modelId: hint,
      detectedModelType: detectedModelType ?? null,
    });
    return;
  }
  if (source.kind === 'contentUri' || source.kind === 'securityScoped') {
    logFallback('skip: source kind cannot materialize lexicon', {
      kind: source.kind,
    });
    return;
  }
  try {
    const modelDir = await resolveFileSourceForModelInit(source);
    await ensureEnUsTtsLexiconInModelDir(modelDir);
  } catch (e) {
    logFallback('prepare failed', {
      error: e instanceof Error ? e.message : String(e),
    });
    console.warn(
      '[TtsLexiconFallback] Lexicon prepare failed:',
      e instanceof Error ? e.message : e
    );
  }
}
