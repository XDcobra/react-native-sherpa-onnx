import type { ModelLanguage } from './types';

/**
 * ISO 639-2/B (3-letter) → ISO 639-1 when a common 2-letter code exists.
 * Extends MMS-style mapping from native TTS catalog metadata.
 */
const ISO639_2_B_TO_1: Readonly<Record<string, string>> = {
  deu: 'de',
  eng: 'en',
  fra: 'fr',
  rus: 'ru',
  spa: 'es',
  tha: 'th',
  ukr: 'uk',
  ita: 'it',
  por: 'pt',
  nld: 'nl',
  pol: 'pl',
  tur: 'tr',
  ara: 'ar',
  hin: 'hi',
  jpn: 'ja',
  kor: 'ko',
  zho: 'zh',
  cmn: 'zh',
};

/** Whisper uses "jw" for Javanese; ISO 639-1 is "jv". */
const TAG_ALIASES: Readonly<Record<string, string>> = {
  jw: 'jv',
};

/**
 * Public `languages` strings may include these 3-letter tags where the models use them
 * (not all have ISO 639-1 codes).
 */
const PRIMARY_TAGS_THREE_LETTER: ReadonlySet<string> = new Set([
  'yue',
  'haw',
  'fil',
  'nan',
]);

const FUNASR_LABEL_TO_ISO: Readonly<Record<string, string>> = {
  中文: 'zh',
  英文: 'en',
  日文: 'ja',
  粤语: 'yue',
  韩文: 'ko',
  越南语: 'vi',
  印尼语: 'id',
  泰语: 'th',
  马来语: 'ms',
  菲律宾语: 'fil',
  阿拉伯语: 'ar',
  印地语: 'hi',
  保加利亚语: 'bg',
  克罗地亚语: 'hr',
  捷克语: 'cs',
  丹麦语: 'da',
  荷兰语: 'nl',
  爱沙尼亚语: 'et',
  芬兰语: 'fi',
  希腊语: 'el',
  匈牙利语: 'hu',
  爱尔兰语: 'ga',
  拉脱维亚语: 'lv',
  立陶宛语: 'lt',
  马耳他语: 'mt',
  波兰语: 'pl',
  葡萄牙语: 'pt',
  罗马尼亚语: 'ro',
  斯洛伐克语: 'sk',
  斯洛文尼亚语: 'sl',
  瑞典语: 'sv',
};

function isLowerAlpha2(s: string): boolean {
  return s.length === 2 && /^[a-z]{2}$/.test(s);
}

function pushUnique(out: string[], code: string): void {
  if (code && !out.includes(code)) {
    out.push(code);
  }
}

/**
 * Normalize one heuristic tag (folder/catalog/native) to a public primary language hint:
 * mostly ISO 639-1 lowercase; also `yue`, `nan`, `fil`, `haw` where used by the stacks.
 */
export function normalizePublicLanguageTag(raw: string): string | undefined {
  const trimmed = raw.trim();
  const t = trimmed.toLowerCase();
  if (!t || t === 'auto') {
    return undefined;
  }
  const aliased = TAG_ALIASES[t] ?? t;
  if (isLowerAlpha2(aliased)) {
    return aliased;
  }
  if (aliased === 'nan') {
    return 'nan';
  }
  if (aliased.length === 3 && /^[a-z]{3}$/.test(aliased)) {
    const from2 = ISO639_2_B_TO_1[aliased];
    if (from2) {
      return from2;
    }
    if (PRIMARY_TAGS_THREE_LETTER.has(aliased)) {
      return aliased;
    }
  }
  if (
    aliased.length === 5 &&
    aliased[2] === '-' &&
    isLowerAlpha2(aliased.slice(0, 2)) &&
    /^[A-Z]{2}$/.test(aliased.slice(3, 5))
  ) {
    return aliased.slice(0, 2);
  }
  const fun = FUNASR_LABEL_TO_ISO[trimmed];
  if (fun != null) {
    return fun;
  }
  return undefined;
}

export function normalizePublicLanguageList(
  raw: readonly string[] | undefined
): string[] {
  if (!raw?.length) {
    return [];
  }
  const out: string[] = [];
  for (const s of raw) {
    const n = normalizePublicLanguageTag(s);
    if (n) {
      pushUnique(out, n);
    }
  }
  return out;
}

export function mergeUniqueLanguageHints(
  primary: readonly string[],
  secondary: readonly string[] | undefined
): string[] {
  const out = [...primary];
  if (secondary?.length) {
    for (const s of secondary) {
      pushUnique(out, s);
    }
  }
  return out;
}

/** Map `ModelLanguage` rows to public primary tags (deduped). */
export function iso6391HintsFromModelLanguages(
  entries: readonly ModelLanguage[],
  options?: { excludeIds?: ReadonlySet<string> }
): string[] {
  const exclude = options?.excludeIds;
  const out: string[] = [];
  for (const e of entries) {
    if (exclude?.has(e.id)) {
      continue;
    }
    const fromFun = FUNASR_LABEL_TO_ISO[e.id];
    if (fromFun) {
      pushUnique(out, fromFun);
      continue;
    }
    const n = normalizePublicLanguageTag(e.id);
    if (n) {
      pushUnique(out, n);
      continue;
    }
    const dolphin = dolphinLocaleIdToPublicLanguageHint(e.id);
    if (dolphin) {
      pushUnique(out, dolphin);
    }
  }
  return out;
}

/** Dolphin locale-style ids (e.g. zh-cn, ct-hk) → coarse public hints. */
export function dolphinLocaleIdToPublicLanguageHint(
  id: string
): string | undefined {
  const t = id.trim().toLowerCase();
  if (!t) {
    return undefined;
  }
  if (t === 'jw-id') {
    return 'jv';
  }
  if (t.startsWith('zh-')) {
    return 'zh';
  }
  if (t.startsWith('ct-')) {
    return 'yue';
  }
  if (t.startsWith('ja-')) {
    return 'ja';
  }
  if (t.startsWith('ko-')) {
    return 'ko';
  }
  if (t.startsWith('en-')) {
    return 'en';
  }
  const first = t.split('-')[0] ?? '';
  if (first.length === 2 && /^[a-z]{2}$/.test(first)) {
    return TAG_ALIASES[first] ?? first;
  }
  return undefined;
}
