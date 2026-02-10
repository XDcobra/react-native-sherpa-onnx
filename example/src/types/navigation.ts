export type RootStackParamList = {
  Home: undefined;
  STT: undefined;
  TTS: undefined;
  VAD: undefined;
  Diarization: undefined;
  Enhancement: undefined;
  Separation: undefined;
};

export type FeatureId =
  | 'stt'
  | 'tts'
  | 'vad'
  | 'diarization'
  | 'enhancement'
  | 'separation';

export interface Feature {
  id: FeatureId;
  title: string;
  description: string;
  icon: string;
  screen: keyof RootStackParamList;
  implemented: boolean;
}
