export type RootStackParamList = {
  Home: undefined;
  STT: undefined;
  TTS: undefined;
  GenerateTimestamp: undefined;
  VAD: undefined;
  Diarization: undefined;
  Enhancement: undefined;
  Separation: undefined;
  Settings: undefined;
};

export type FeatureId =
  | 'stt'
  | 'tts'
  | 'generate_timestamp'
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
