/**
 * Map common ISO 639-1 (and a few aliases) to uroman ISO 639-3 `lcode` values.
 * Unknown 3-letter codes pass through; unknown 2-letter codes yield undefined.
 */
const ISO6391_TO_6393: Record<string, string> = {
  ar: 'ara',
  bg: 'bul',
  cs: 'ces',
  da: 'dan',
  de: 'deu',
  el: 'ell',
  en: 'eng',
  es: 'spa',
  et: 'est',
  fa: 'fas',
  fi: 'fin',
  fr: 'fra',
  he: 'heb',
  hi: 'hin',
  hr: 'hrv',
  hu: 'hun',
  hy: 'hye',
  id: 'ind',
  is: 'isl',
  it: 'ita',
  ja: 'jpn',
  ka: 'kat',
  kk: 'kaz',
  ko: 'kor',
  lt: 'lit',
  lv: 'lav',
  mk: 'mkd',
  mn: 'mon',
  ms: 'msa',
  nl: 'nld',
  no: 'nor',
  pl: 'pol',
  pt: 'por',
  ro: 'ron',
  ru: 'rus',
  sk: 'slk',
  sl: 'slv',
  sr: 'srp',
  sv: 'swe',
  th: 'tha',
  tr: 'tur',
  uk: 'ukr',
  ur: 'urd',
  vi: 'vie',
  zh: 'zho',
};

export function toUromanLanguageCode(
  language: string | undefined | null
): string | undefined {
  if (!language) {
    return undefined;
  }
  const key = language.trim().toLowerCase();
  if (!key) {
    return undefined;
  }
  // Accept BCP-47 prefixes: "ru-RU" → "ru"
  const primary = key.split(/[-_]/)[0] ?? key;
  if (primary.length === 3 && /^[a-z]{3}$/.test(primary)) {
    return primary;
  }
  if (primary.length === 2 && /^[a-z]{2}$/.test(primary)) {
    return ISO6391_TO_6393[primary];
  }
  return undefined;
}
