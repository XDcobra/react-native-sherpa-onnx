import type { ModelLanguage } from '../types';

// FunASR: ids are values passed to model.generate(..., language="中文").

export const FUNASR_NANO_LANGUAGES: readonly ModelLanguage[] = [
  { id: '中文', name: 'chinese' },
  { id: '英文', name: 'english' },
  { id: '日文', name: 'japanese' },
] as const;

export const FUNASR_MLT_NANO_LANGUAGES: readonly ModelLanguage[] = [
  { id: '中文', name: 'chinese' },
  { id: '英文', name: 'english' },
  { id: '粤语', name: 'cantonese' },
  { id: '日文', name: 'japanese' },
  { id: '韩文', name: 'korean' },
  { id: '越南语', name: 'vietnamese' },
  { id: '印尼语', name: 'indonesian' },
  { id: '泰语', name: 'thai' },
  { id: '马来语', name: 'malay' },
  { id: '菲律宾语', name: 'filipino' },
  { id: '阿拉伯语', name: 'arabic' },
  { id: '印地语', name: 'hindi' },
  { id: '保加利亚语', name: 'bulgarian' },
  { id: '克罗地亚语', name: 'croatian' },
  { id: '捷克语', name: 'czech' },
  { id: '丹麦语', name: 'danish' },
  { id: '荷兰语', name: 'dutch' },
  { id: '爱沙尼亚语', name: 'estonian' },
  { id: '芬兰语', name: 'finnish' },
  { id: '希腊语', name: 'greek' },
  { id: '匈牙利语', name: 'hungarian' },
  { id: '爱尔兰语', name: 'irish' },
  { id: '拉脱维亚语', name: 'latvian' },
  { id: '立陶宛语', name: 'lithuanian' },
  { id: '马耳他语', name: 'maltese' },
  { id: '波兰语', name: 'polish' },
  { id: '葡萄牙语', name: 'portuguese' },
  { id: '罗马尼亚语', name: 'romanian' },
  { id: '斯洛伐克语', name: 'slovak' },
  { id: '斯洛文尼亚语', name: 'slovenian' },
  { id: '瑞典语', name: 'swedish' },
] as const;

export function getFunasrNanoLanguages(): readonly ModelLanguage[] {
  return FUNASR_NANO_LANGUAGES;
}

export function getFunasrMltNanoLanguages(): readonly ModelLanguage[] {
  return FUNASR_MLT_NANO_LANGUAGES;
}
