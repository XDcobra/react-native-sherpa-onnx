import rulesPayload from './data/rules.json';
import { toUromanLanguageCode } from './langCodes';

type RomRuleEntry = {
  t: string;
  lcodes?: string[];
  startOnly?: boolean;
  notStart?: boolean;
};

type RulesPayload = {
  maxLen: number;
  rules: Record<string, RomRuleEntry[]>;
};

const PAYLOAD = rulesPayload as RulesPayload;
const RULES = PAYLOAD.rules;
const MAX_LEN = PAYLOAD.maxLen;

const HANGUL_LEADS = 'g gg n d dd r m b bb s ss - j jj c k t p h'.split(' ');
const HANGUL_VOWELS =
  'a ae ya yae eo e yeo ye o wa wai oe yo u weo we wi yu eu yi i'.split(' ');
const HANGUL_TAILS =
  '- g gg gs n nj nh d l lg lm lb ls lt lp lh m b bs s ss ng j c k t p h'.split(
    ' '
  );

function hangulRomanizeChar(ch: string): string | undefined {
  const cp = ch.codePointAt(0);
  if (cp === undefined || cp < 0xac00 || cp > 0xd7a3) {
    return undefined;
  }
  const code = cp - 0xac00;
  const lead = Math.floor(code / (28 * 21));
  const vowel = Math.floor(code / 28) % 21;
  const tail = code % 28;
  const rom =
    (HANGUL_LEADS[lead] ?? '') +
    (HANGUL_VOWELS[vowel] ?? '') +
    (HANGUL_TAILS[tail] ?? '');
  return rom.replace(/-/g, '');
}

function isWordStart(text: string, index: number): boolean {
  if (index <= 0) {
    return true;
  }
  const prev = text[index - 1] ?? '';
  return /[\s.,;:!?"'()[\]{}<>/\\]/.test(prev);
}

function pickRuleTarget(
  entries: RomRuleEntry[],
  lcode: string | undefined,
  atStart: boolean
): string | undefined {
  const ranked: Array<{ score: number; t: string }> = [];
  for (const entry of entries) {
    const lcodes = entry.lcodes;
    if (lcodes && lcodes.length > 0) {
      if (!lcode || !lcodes.includes(lcode)) {
        continue;
      }
    }
    if (entry.startOnly && !atStart) {
      continue;
    }
    if (entry.notStart && atStart) {
      continue;
    }
    ranked.push({
      score: lcodes && lcodes.length > 0 ? 1 : 0,
      t: entry.t,
    });
  }
  if (ranked.length === 0) {
    // Fallback: unconstrained default (no lcodes), ignore start flags.
    for (const entry of entries) {
      if (entry.lcodes && entry.lcodes.length > 0) {
        continue;
      }
      ranked.push({ score: 0, t: entry.t });
    }
  }
  if (ranked.length === 0) {
    return undefined;
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked[0]?.t;
}

/**
 * Greedy longest-match uroman string romanizer using exported rule tables.
 * Not a full lattice port; covers the MMS FA char-CTC transcript path.
 */
export function romanizeString(text: string, language?: string | null): string {
  if (!text) {
    return text;
  }
  const lcode = toUromanLanguageCode(language);
  let i = 0;
  let out = '';
  while (i < text.length) {
    const atStart = isWordStart(text, i);
    let matched: string | undefined;
    let matchedLen = 1;
    const max = Math.min(MAX_LEN, text.length - i);
    for (let len = max; len >= 1; len -= 1) {
      const chunk = text.slice(i, i + len);
      const entries = RULES[chunk];
      if (!entries || entries.length === 0) {
        continue;
      }
      const t = pickRuleTarget(entries, lcode, atStart);
      if (t !== undefined) {
        matched = t;
        matchedLen = len;
        break;
      }
    }
    if (matched === undefined) {
      const ch = text[i] ?? '';
      matched = hangulRomanizeChar(ch) ?? ch;
      matchedLen = 1;
    }
    out += matched;
    i += matchedLen;
  }
  return out;
}
