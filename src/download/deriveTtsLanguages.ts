/** ISO 639-2 Terminology → ISO 639-1 for sherpa `vits-mms-*` release names. */
const MMS_ISO639_2_TO_639_1: Record<string, string> = {
  deu: 'de',
  eng: 'en',
  fra: 'fr',
  rus: 'ru',
  spa: 'es',
  tha: 'th',
  ukr: 'uk',
};

/**
 * Piper / Mimic3 / Icefall use BCP-47-like `ll_RR` (language + ISO 3166-1 alpha-2 region).
 * Collapse to the language subtag only so a later `nl-be`-style split does not add a false `be`.
 */
function collapseLocaleLanguageRegionUnderscore(id: string): string {
  return id.replace(/([a-z]{2})_([A-Z]{2})/g, '$1');
}

/** Two-letter segments in sherpa TTS ids that are not ISO 639-1 language codes. */
const FALSE_POSITIVE_TWO_LETTER_TOKENS = new Set([
  'hf', // Hugging Face, e.g. vits-zh-hf-*
  'll', // model variant, e.g. sherpa-onnx-vits-zh-ll
]);

function collectLanguagesFromTokens(id: string): string[] {
  const tokens = id.split(/[-_]+/g);
  const languages = new Set<string>();
  for (const token of tokens) {
    if (/^[a-z]{2}$/.test(token)) {
      if (!FALSE_POSITIVE_TWO_LETTER_TOKENS.has(token)) {
        languages.add(token);
      }
      continue;
    }
    if (/^[a-z]{2}[A-Z]{2}$/.test(token)) {
      languages.add(token.slice(0, 2).toLowerCase());
      continue;
    }
    if (/^[a-z]{2}-[A-Z]{2}$/.test(token)) {
      languages.add(token.slice(0, 2).toLowerCase());
    }
  }
  return Array.from(languages);
}

/** Best-effort language tags from TTS asset ids (see test/fixtures/tts-models-expected.csv). */
export function deriveLanguages(id: string): string[] {
  const lower = id.toLowerCase();

  if (lower.startsWith('vits-coqui-')) {
    const segment = id.split('-')[2];
    if (segment && /^[a-z]{2}$/i.test(segment)) {
      return [segment.toLowerCase()];
    }
  }

  if (lower.startsWith('vits-mms-')) {
    const segment = id.split('-')[2];
    if (segment) {
      const key = segment.toLowerCase();
      const mapped = MMS_ISO639_2_TO_639_1[key];
      if (mapped) {
        return [mapped];
      }
      if (key === 'nan') {
        return ['nan'];
      }
    }
  }

  const normalized = collapseLocaleLanguageRegionUnderscore(id);
  return collectLanguagesFromTokens(normalized);
}
