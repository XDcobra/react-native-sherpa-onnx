export type RootStackParamList = {
  Home: undefined;
  STT: undefined;
  TTS: undefined;
  STTStreaming: undefined;
  TTSStreaming: undefined;
  PipelineShowcase: undefined;
  GenerateTimestamp: undefined;
  DownloadShowcase: undefined;
  VAD: undefined;
  Diarization: undefined;
  Enhancement: undefined;
  EnhancementStreaming: undefined;
  Separation: undefined;
  Settings: undefined;
};

export type FeatureId =
  | 'stt'
  | 'tts'
  | 'stt_streaming'
  | 'tts_streaming'
  | 'pipeline_showcase'
  | 'generate_timestamp'
  | 'download_showcase'
  | 'vad'
  | 'diarization'
  | 'enhancement'
  | 'enhancement_streaming'
  | 'separation';

export interface Feature {
  id: FeatureId;
  title: string;
  description: string;
  icon: string;
  screen: keyof RootStackParamList;
  implemented: boolean;
}
