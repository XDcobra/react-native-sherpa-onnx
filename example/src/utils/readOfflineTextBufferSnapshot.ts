/**
 * Read a full OfflineTextBuffer snapshot for example-app result UIs.
 * Empty counts / missing meta → empty arrays or ''.
 */

import {
  getOfflineTextBufferDurationsSlice,
  getOfflineTextBufferEmotion,
  getOfflineTextBufferEvent,
  getOfflineTextBufferLang,
  getOfflineTextBufferTextSlice,
  getOfflineTextBufferTimestampsSlice,
  getOfflineTextBufferTokensSlice,
  getPipelineTextBufferInfo,
  type OfflineTextBufferInfo,
} from 'react-native-sherpa-onnx/textbuffer';

export type OfflineTextBufferSnapshot = {
  bufferId: string;
  text: string;
  tokens: string[];
  timestamps: number[];
  durations: number[];
  lang: string;
  emotion: string;
  event: string;
  utf16Length: number;
};

export async function readOfflineTextBufferSnapshot(
  bufferId: string
): Promise<OfflineTextBufferSnapshot> {
  const rawInfo = await getPipelineTextBufferInfo(bufferId);
  const info = rawInfo as OfflineTextBufferInfo;
  const utf16Length =
    typeof info.utf16Length === 'number' ? info.utf16Length : 0;

  const [text, tokens, timestamps, durations, lang, emotion, event] =
    await Promise.all([
      utf16Length > 0
        ? getOfflineTextBufferTextSlice(bufferId, 0, utf16Length)
        : Promise.resolve(''),
      info.tokenCount > 0
        ? getOfflineTextBufferTokensSlice(bufferId, 0, info.tokenCount)
        : Promise.resolve([] as string[]),
      info.timestampCount > 0
        ? getOfflineTextBufferTimestampsSlice(bufferId, 0, info.timestampCount)
        : Promise.resolve([] as number[]),
      info.durationCount > 0
        ? getOfflineTextBufferDurationsSlice(bufferId, 0, info.durationCount)
        : Promise.resolve([] as number[]),
      info.hasLang ? getOfflineTextBufferLang(bufferId) : Promise.resolve(''),
      info.hasEmotion
        ? getOfflineTextBufferEmotion(bufferId)
        : Promise.resolve(''),
      info.hasEvent ? getOfflineTextBufferEvent(bufferId) : Promise.resolve(''),
    ]);

  return {
    bufferId,
    text,
    tokens,
    timestamps,
    durations,
    lang,
    emotion,
    event,
    utf16Length,
  };
}
