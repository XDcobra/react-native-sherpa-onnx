#!/usr/bin/env node
/**
 * Generate C++ embed data and TypeScript picker exports from catalog/model-language-catalog.json.
 *
 * Usage:
 *   node scripts/generate-model-language-catalog.mjs
 *   yarn generate:model-language-catalog
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CATALOG_PATH = path.join(ROOT, 'catalog/model-language-catalog.json');
const CPP_OUT = path.join(
  ROOT,
  'android/src/main/cpp/jni/model_detect/common/model_language_catalog.inc.h'
);
const TS_OUT = path.join(ROOT, 'src/model-languages/generated/catalog.ts');

const FUNASR_LABEL_TO_ISO = {
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

const TAG_ALIASES = { jw: 'jv' };
const PRIMARY_TAGS_THREE_LETTER = new Set(['yue', 'haw', 'fil', 'nan']);

function pushUnique(out, code) {
  if (code && !out.includes(code)) {
    out.push(code);
  }
}

function normalizePublicLanguageTag(raw) {
  const trimmed = raw.trim();
  const t = trimmed.toLowerCase();
  if (!t || t === 'auto') return undefined;
  const aliased = TAG_ALIASES[t] ?? t;
  if (aliased.length === 2 && /^[a-z]{2}$/.test(aliased)) return aliased;
  if (aliased === 'nan') return 'nan';
  if (aliased.length === 3 && /^[a-z]{3}$/.test(aliased)) {
    if (PRIMARY_TAGS_THREE_LETTER.has(aliased)) return aliased;
  }
  if (
    aliased.length === 5 &&
    aliased[2] === '-' &&
    /^[a-z]{2}$/.test(aliased.slice(0, 2)) &&
    /^[A-Z]{2}$/.test(aliased.slice(3, 5))
  ) {
    return aliased.slice(0, 2);
  }
  const fun = FUNASR_LABEL_TO_ISO[trimmed];
  if (fun != null) return fun;
  return undefined;
}

function dolphinLocaleIdToPublicLanguageHint(id) {
  const t = id.trim().toLowerCase();
  if (!t) return undefined;
  if (t === 'jw-id') return 'jv';
  if (t.startsWith('zh-')) return 'zh';
  if (t.startsWith('ct-')) return 'yue';
  if (t.startsWith('ja-')) return 'ja';
  if (t.startsWith('ko-')) return 'ko';
  if (t.startsWith('en-')) return 'en';
  const first = t.split('-')[0] ?? '';
  if (first.length === 2 && /^[a-z]{2}$/.test(first)) {
    return TAG_ALIASES[first] ?? first;
  }
  return undefined;
}

function rowFromEntry(entry) {
  const fromFun = FUNASR_LABEL_TO_ISO[entry.id];
  if (fromFun) {
    return { iso6391Hint: fromFun, id: entry.id };
  }
  const n = normalizePublicLanguageTag(entry.id);
  if (n) {
    return { iso6391Hint: n, id: entry.id };
  }
  const dolphin = dolphinLocaleIdToPublicLanguageHint(entry.id);
  if (dolphin) {
    return { iso6391Hint: dolphin, id: entry.id };
  }
  return null;
}

function rowsFromSttSpec(spec) {
  if (spec.hints) {
    return spec.hints.map((h) => ({ iso6391Hint: h, id: h }));
  }
  if (spec.entries) {
    const exclude = new Set(spec.excludeFromHints ?? []);
    const rows = [];
    for (const e of spec.entries) {
      if (exclude.has(e.id)) continue;
      const row = rowFromEntry(e);
      if (row) rows.push(row);
    }
    return rows;
  }
  return [];
}

function rowsFromTtsHints(hints) {
  return hints.map((h) => ({ iso6391Hint: h, id: h }));
}

function hintsFromRows(rows) {
  const out = [];
  for (const row of rows) {
    pushUnique(out, row.iso6391Hint);
  }
  return out;
}

function hintsFromEntries(entries, excludeIds = []) {
  return hintsFromRows(rowsFromSttSpec({ entries, excludeFromHints: excludeIds }));
}

function cppString(s) {
  return JSON.stringify(s);
}

function cppStringArray(values) {
  const items = values.map((v) => cppString(v)).join(', ');
  return `{${items}}`;
}

function cppPublicLanguageRow(row) {
  return `PublicLanguageRow{${cppString(row.iso6391Hint)}, ${cppString(row.id)}}`;
}

function cppRowArray(rows) {
  const items = rows.map((r) => cppPublicLanguageRow(r)).join(', ');
  return `{${items}}`;
}

function validateCatalog(catalog) {
  if (catalog.version !== 1) {
    throw new Error(`Unsupported catalog version: ${catalog.version}`);
  }
  if (!catalog.tts || !catalog.stt) {
    throw new Error('Catalog must have tts and stt domains');
  }
  const funasr = catalog.stt.funasr_nano;
  if (funasr?.entries) {
    validateFunasrPickerVariants(funasr);
  }
}

function validateFunasrPickerVariants(spec) {
  const variants = spec.pickerVariants;
  if (!variants?.nano?.length || !variants?.mlt?.length) {
    throw new Error('funasr_nano requires pickerVariants.nano and pickerVariants.mlt');
  }
  const entryIds = new Set(spec.entries.map((e) => e.id));
  for (const key of ['nano', 'mlt']) {
    for (const row of variants[key]) {
      if (!entryIds.has(row.id)) {
        throw new Error(
          `funasr_nano pickerVariants.${key} id ${JSON.stringify(row.id)} not in entries`
        );
      }
    }
  }
}

function sttConstName(modelType) {
  const map = {
    whisper: 'WHISPER_LANGUAGES',
    sense_voice: 'SENSEVOICE_LANGUAGES',
    canary: 'CANARY_LANGUAGES',
    funasr_nano: 'FUNASR_NANO_LANGUAGES',
    qwen3_asr: 'QWEN3_ASR_LANGUAGES',
    cohere_transcribe: 'COHERE_TRANSCRIBE_LANGUAGES',
    dolphin: 'DOLPHIN_INFO_LANGUAGES',
  };
  return map[modelType];
}

function sttGetterName(modelType) {
  const map = {
    whisper: 'getWhisperLanguages',
    sense_voice: 'getSenseVoiceLanguages',
    canary: 'getCanaryLanguages',
    funasr_nano: 'getFunasrNanoLanguages',
    qwen3_asr: 'getQwen3AsrLanguages',
    cohere_transcribe: 'getCohereTranscribeLanguages',
    dolphin: 'getDolphinInfoLanguages',
  };
  return map[modelType];
}

function emitCpp(catalog, sttRowsByType) {
  const lines = [];
  lines.push('// GENERATED by scripts/generate-model-language-catalog.mjs — do not edit.');
  lines.push('#pragma once');
  lines.push('');
  lines.push('#include "sherpa-onnx-model-detect.h"');
  lines.push('');
  lines.push('#include <cctype>');
  lines.push('#include <string>');
  lines.push('#include <unordered_map>');
  lines.push('#include <vector>');
  lines.push('');
  lines.push('namespace sherpaonnx::model_language_catalog {');
  lines.push('');
  lines.push('inline bool IsSupertonic3ModelKey(const std::string& modelKey) {');
  lines.push('    if (modelKey.empty()) return false;');
  lines.push('    std::string lower;');
  lines.push('    lower.reserve(modelKey.size());');
  lines.push('    for (unsigned char c : modelKey) {');
  lines.push('        lower.push_back(static_cast<char>(std::tolower(c)));');
  lines.push('    }');
  lines.push('    if (lower.find("supertonic") == std::string::npos) return false;');
  lines.push('    if (lower.find("supertonic-3") != std::string::npos) return true;');
  lines.push('    if (lower.find("supertonic_3") != std::string::npos) return true;');
  lines.push('    if (lower.find("supertonic-v3") != std::string::npos) return true;');
  lines.push('    const std::string needle = "supertonic3";');
  lines.push('    const auto pos = lower.find(needle);');
  lines.push('    if (pos == std::string::npos) return false;');
  lines.push('    const std::size_t after = pos + needle.size();');
  lines.push('    if (after >= lower.size()) return true;');
  lines.push('    const char next = lower[after];');
  lines.push('    return next == \'_\' || next == \'-\' || next == \'.\';');
  lines.push('}');
  lines.push('');

  // TTS simple rows
  lines.push('inline const std::vector<PublicLanguageRow>& TtsSimpleRows(');
  lines.push('    const std::string& modelType) {');
  lines.push(
    '    static const std::unordered_map<std::string, std::vector<PublicLanguageRow>> kMap = {'
  );
  for (const [modelType, spec] of Object.entries(catalog.tts)) {
    if (spec.hints) {
      lines.push(
        `        {${cppString(modelType)}, ${cppRowArray(rowsFromTtsHints(spec.hints))}},`
      );
    }
  }
  lines.push('    };');
  lines.push('    static const std::vector<PublicLanguageRow> kEmpty;');
  lines.push('    const auto it = kMap.find(modelType);');
  lines.push('    return it == kMap.end() ? kEmpty : it->second;');
  lines.push('}');
  lines.push('');

  // Supertonic variants
  const supertonic = catalog.tts.supertonic;
  if (supertonic?.variants) {
    for (const v of supertonic.variants) {
      if (v.modelKeyMatch === 'default') {
        lines.push('inline const std::vector<PublicLanguageRow>& SupertonicDefaultRows() {');
        lines.push(
          `    static const std::vector<PublicLanguageRow> kRows = ${cppRowArray(rowsFromTtsHints(v.hints))};`
        );
        lines.push('    return kRows;');
        lines.push('}');
      } else {
        lines.push('inline const std::vector<PublicLanguageRow>& SupertonicV3Rows() {');
        lines.push(
          `    static const std::vector<PublicLanguageRow> kRows = ${cppRowArray(rowsFromTtsHints(v.hints))};`
        );
        lines.push('    return kRows;');
        lines.push('}');
      }
    }
    lines.push('');
    lines.push('inline const std::vector<PublicLanguageRow>& TtsSupertonicRows(');
    lines.push('    const std::string& modelKey) {');
    lines.push('    if (IsSupertonic3ModelKey(modelKey)) {');
    lines.push('        return SupertonicV3Rows();');
    lines.push('    }');
    lines.push('    return SupertonicDefaultRows();');
    lines.push('}');
    lines.push('');
  }

  // STT rows
  lines.push('inline const std::vector<PublicLanguageRow>& SttRowsForModelType(');
  lines.push('    const std::string& modelType) {');
  lines.push(
    '    static const std::unordered_map<std::string, std::vector<PublicLanguageRow>> kMap = {'
  );
  for (const [modelType, rows] of Object.entries(sttRowsByType)) {
    lines.push(`        {${cppString(modelType)}, ${cppRowArray(rows)}},`);
  }
  lines.push('    };');
  lines.push('    static const std::vector<PublicLanguageRow> kEmpty;');
  lines.push('    const auto it = kMap.find(modelType);');
  lines.push('    return it == kMap.end() ? kEmpty : it->second;');
  lines.push('}');
  lines.push('');

  // ModelOptionIdForHint — first-match hint→id for heuristic upgrade
  lines.push('inline std::string ModelOptionIdForHint(');
  lines.push('    const std::string& modelType,');
  lines.push('    const std::string& hint) {');
  lines.push('    if (modelType == "moonshine" || modelType == "moonshine_v2") {');
  lines.push('        return hint;');
  lines.push('    }');
  lines.push('    const auto& rows = SttRowsForModelType(modelType);');
  lines.push('    for (const auto& row : rows) {');
  lines.push('        if (row.iso6391Hint == hint) {');
  lines.push('            return row.id;');
  lines.push('        }');
  lines.push('    }');
  lines.push('    return hint;');
  lines.push('}');
  lines.push('');
  lines.push('} // namespace sherpaonnx::model_language_catalog');
  lines.push('');
  return lines.join('\n');
}

function emitTs(catalog, sttHintsByType) {
  const lines = [];
  lines.push('// GENERATED by scripts/generate-model-language-catalog.mjs — do not edit.');
  lines.push('');
  lines.push("import type { ModelLanguage } from '../types';");
  lines.push('');

  // STT entry exports
  for (const [modelType, spec] of Object.entries(catalog.stt)) {
    if (!spec.entries) continue;
    const constName = sttConstName(modelType);
    const getter = sttGetterName(modelType);
    if (!constName || !getter) continue;
    if (modelType === 'funasr_nano') {
      const { nano, mlt } = spec.pickerVariants;
      lines.push(
        `export const FUNASR_NANO_ENTRIES: readonly ModelLanguage[] = ${JSON.stringify(spec.entries, null, 2)} as const;`
      );
      lines.push('');
      lines.push(
        `export const FUNASR_NANO_LANGUAGES: readonly ModelLanguage[] = ${JSON.stringify(nano, null, 2)} as const;`
      );
      lines.push('');
      lines.push('export function getFunasrNanoLanguages(): readonly ModelLanguage[] {');
      lines.push('  return FUNASR_NANO_LANGUAGES;');
      lines.push('}');
      lines.push('');
      lines.push(
        `export const FUNASR_MLT_NANO_LANGUAGES: readonly ModelLanguage[] = ${JSON.stringify(mlt, null, 2)} as const;`
      );
      lines.push('');
      lines.push('export function getFunasrMltNanoLanguages(): readonly ModelLanguage[] {');
      lines.push('  return FUNASR_MLT_NANO_LANGUAGES;');
      lines.push('}');
      lines.push('');
      continue;
    }
    lines.push(
      `export const ${constName}: readonly ModelLanguage[] = ${JSON.stringify(spec.entries, null, 2)} as const;`
    );
    lines.push('');
    lines.push(`export function ${getter}(): readonly ModelLanguage[] {`);
    lines.push(`  return ${constName};`);
    lines.push('}');
    lines.push('');
  }

  // TTS hints
  lines.push(
    `export const POCKET_TTS_ISO6391_HINTS = ${JSON.stringify(catalog.tts.pocket.hints)} as const;`
  );
  lines.push('');
  const st3 = catalog.tts.supertonic.variants.find((v) => v.modelKeyMatch !== 'default');
  const stLegacy = catalog.tts.supertonic.variants.find((v) => v.modelKeyMatch === 'default');
  lines.push(
    `export const SUPERTONIC3_TTS_ISO6391_HINTS = ${JSON.stringify(st3.hints)} as const;`
  );
  lines.push('');
  lines.push(
    `export const SUPERTONIC_TTS_ISO6391_HINTS = ${JSON.stringify(stLegacy.hints)} as const;`
  );
  lines.push('');
  lines.push('/** True when modelKey denotes Supertonic 3 (not legacy Supertonic bundles). */');
  lines.push('export function isSupertonic3ModelKey(modelKey: string | undefined): boolean {');
  lines.push('  if (!modelKey?.trim()) return false;');
  lines.push('  const lower = modelKey.trim().toLowerCase();');
  lines.push('  if (!lower.includes(\'supertonic\')) return false;');
  lines.push('  return (');
  lines.push('    lower.includes(\'supertonic-3\') ||');
  lines.push('    lower.includes(\'supertonic_3\') ||');
  lines.push('    lower.includes(\'supertonic-v3\') ||');
  lines.push('    /supertonic3(?:[_\\-.]|$)/.test(lower)');
  lines.push('  );');
  lines.push('}');
  lines.push('');

  lines.push('export function iso6391HintsForTtsModelType(');
  lines.push('  modelType: string | undefined,');
  lines.push('  modelKey?: string');
  lines.push('): string[] | undefined {');
  lines.push('  if (!modelType) return undefined;');
  lines.push('  switch (modelType) {');
  lines.push('    case \'pocket\':');
  lines.push('      return [...POCKET_TTS_ISO6391_HINTS];');
  lines.push('    case \'supertonic\':');
  lines.push('      if (isSupertonic3ModelKey(modelKey)) {');
  lines.push('        return [...SUPERTONIC3_TTS_ISO6391_HINTS];');
  lines.push('      }');
  lines.push('      return [...SUPERTONIC_TTS_ISO6391_HINTS];');
  lines.push('    default:');
  lines.push('      return undefined;');
  lines.push('  }');
  lines.push('}');
  lines.push('');

  lines.push('const STT_ENTRIES: Readonly<Record<string, readonly ModelLanguage[]>> = {');
  for (const [modelType, spec] of Object.entries(catalog.stt)) {
    if (!spec.entries) continue;
    const constName = sttConstName(modelType);
    if (!constName) continue;
    if (modelType === 'funasr_nano') {
      lines.push(`  ${cppString(modelType)}: FUNASR_NANO_ENTRIES,`);
      continue;
    }
    lines.push(`  ${cppString(modelType)}: ${constName},`);
  }
  lines.push('};');
  lines.push('');
  lines.push('export function sttModelLanguagesForModelType(');
  lines.push('  modelType: string | undefined');
  lines.push('): readonly ModelLanguage[] | undefined {');
  lines.push('  if (!modelType) return undefined;');
  lines.push('  return STT_ENTRIES[modelType];');
  lines.push('}');
  lines.push('');

  lines.push('export function iso6391HintsForSttModelType(');
  lines.push('  modelType: string | undefined');
  lines.push('): string[] | undefined {');
  lines.push('  if (!modelType) return undefined;');
  lines.push('  const hints = STT_HINTS[modelType];');
  lines.push('  return hints ? [...hints] : undefined;');
  lines.push('}');
  lines.push('');
  lines.push('const STT_HINTS: Readonly<Record<string, readonly string[]>> = {');
  for (const [modelType, hints] of Object.entries(sttHintsByType)) {
    lines.push(`  ${cppString(modelType)}: ${JSON.stringify(hints)},`);
  }
  lines.push('};');
  lines.push('');
  lines.push(`export const CATALOG_VERSION = ${catalog.version};`);
  lines.push('');
  return lines.join('\n');
}

function main() {
  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  validateCatalog(catalog);

  const sttRowsByType = {};
  const sttHintsByType = {};
  for (const [modelType, spec] of Object.entries(catalog.stt)) {
    const rows = rowsFromSttSpec(spec);
    if (rows.length > 0) {
      sttRowsByType[modelType] = rows;
      sttHintsByType[modelType] = hintsFromRows(rows);
    }
  }

  // Validate unique hints per model type (for filter/chip use)
  for (const hints of Object.values(sttHintsByType)) {
    const seen = new Set();
    for (const h of hints) {
      if (seen.has(h)) {
        throw new Error(`Duplicate STT hint: ${h}`);
      }
      seen.add(h);
    }
  }

  fs.mkdirSync(path.dirname(CPP_OUT), { recursive: true });
  fs.mkdirSync(path.dirname(TS_OUT), { recursive: true });
  fs.writeFileSync(CPP_OUT, emitCpp(catalog, sttRowsByType));
  fs.writeFileSync(TS_OUT, emitTs(catalog, sttHintsByType));
  console.log(`Wrote ${CPP_OUT}`);
  console.log(`Wrote ${TS_OUT}`);
}

main();
