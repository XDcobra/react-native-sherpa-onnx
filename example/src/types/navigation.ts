export type RootStackParamList = {
  Home: undefined;
  STT: undefined;
  TTS: undefined;
  PipelineShowcase: undefined;
  GenerateTimestamp: undefined;
  DownloadShowcase: undefined;
  VAD: undefined;
  Diarization: undefined;
  Enhancement: undefined;
  Separation: undefined;
  Settings: undefined;
};

export type FeatureId =
  | 'stt'
  | 'tts'
  | 'pipeline_showcase'
  | 'generate_timestamp'
  | 'download_showcase'
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
