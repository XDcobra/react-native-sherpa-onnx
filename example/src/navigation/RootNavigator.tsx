import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../types/navigation';

import HomeScreen from '../screens/home/HomeScreen';
import STTScreen from '../screens/stt/STTScreen';
import OfflineTTSScreen from '../screens/tts/OfflineTTSScreen';
import STTStreamingScreen from '../screens/stt-streaming/STTStreamingScreen';
import StreamingTTSScreen from '../screens/tts-streaming/StreamingTTSScreen';
import PunctuationScreen from '../screens/punctuation/PunctuationScreen';
import PunctuationStreamingScreen from '../screens/punctuation-streaming/PunctuationStreamingScreen';
import OfflinePipelineShowcaseScreen from '../screens/offline-pipeline-showcase/OfflinePipelineShowcaseScreen';
import LivePipelineShowcaseScreen from '../screens/live-pipeline-showcase/LivePipelineShowcaseScreen';
import GenerateTimestampScreen from '../screens/generate-timestamp/GenerateTimestampScreen';
import DownloadShowcaseScreen from '../screens/download-showcase/DownloadShowcaseScreen';
import VADScreen from '../screens/vad/VADScreen';
import SegmentationShowcaseScreen from '../screens/segmentation-showcase/SegmentationShowcaseScreen';
import DiarizationScreen from '../screens/diarization/DiarizationScreen';
import SpeakerIdentificationScreen from '../screens/speaker-identification/SpeakerIdentificationScreen';
import EnhancementScreen from '../screens/enhancement/EnhancementScreen';
import EnhancementStreamingScreen from '../screens/enhancement-streaming/EnhancementStreamingScreen';
import SeparationScreen from '../screens/separation/SeparationScreen';
import SettingsScreen from '../screens/settings/SettingsScreen';
import FileIOScreen from '../screens/fileio/FileIOScreen';
import AudioVisualizationScreen from '../screens/audio-visualization/AudioVisualizationScreen';
const Stack = createNativeStackNavigator<RootStackParamList>();

export default function RootNavigator() {
  return (
    <Stack.Navigator
      initialRouteName="Home"
      screenOptions={{
        headerStyle: {
          backgroundColor: '#FFFFFF',
        },
        headerTintColor: '#007AFF',
        headerTitleStyle: {
          fontWeight: '600',
        },
        headerShadowVisible: true,
      }}
    >
      <Stack.Screen
        name="Home"
        component={HomeScreen}
        options={{
          headerShown: false,
        }}
      />
      <Stack.Screen
        name="STT"
        component={STTScreen}
        options={{
          title: 'Speech-to-Text',
        }}
      />
      <Stack.Screen
        name="STTStreaming"
        component={STTStreamingScreen}
        options={{
          title: 'Speech-to-Text (Streaming)',
        }}
      />
      <Stack.Screen
        name="TTS"
        component={OfflineTTSScreen}
        options={{
          title: 'Text-to-Speech (Offline)',
        }}
      />
      <Stack.Screen
        name="TTSStreaming"
        component={StreamingTTSScreen}
        options={{
          title: 'Text-to-Speech (Streaming)',
        }}
      />
      <Stack.Screen
        name="Punctuation"
        component={PunctuationScreen}
        options={{
          title: 'Punctuation (offline)',
        }}
      />
      <Stack.Screen
        name="PunctuationStreaming"
        component={PunctuationStreamingScreen}
        options={{
          title: 'Punctuation (Streaming)',
        }}
      />
      <Stack.Screen
        name="OfflinePipelineShowcase"
        component={OfflinePipelineShowcaseScreen}
        options={{
          title: 'Offline Pipeline Showcase',
        }}
      />
      <Stack.Screen
        name="LivePipelineShowcase"
        component={LivePipelineShowcaseScreen}
        options={{
          title: 'Live Pipeline Showcase',
        }}
      />
      <Stack.Screen
        name="GenerateTimestamp"
        component={GenerateTimestampScreen}
        options={{
          title: 'Alignment (Subtitles/Timestamps)',
        }}
      />
      <Stack.Screen
        name="DownloadShowcase"
        component={DownloadShowcaseScreen}
        options={{
          title: 'Downloadmanager',
        }}
      />
      <Stack.Screen
        name="VAD"
        component={VADScreen}
        options={{
          title: 'Voice Activity Detection',
        }}
      />
      <Stack.Screen
        name="SegmentationShowcase"
        component={SegmentationShowcaseScreen}
        options={{
          title: 'Segmentation Showcase',
        }}
      />
      <Stack.Screen
        name="Diarization"
        component={DiarizationScreen}
        options={{
          title: 'Speaker Diarization',
        }}
      />
      <Stack.Screen
        name="SpeakerIdentification"
        component={SpeakerIdentificationScreen}
        options={{
          title: 'Speaker Identification',
        }}
      />
      <Stack.Screen
        name="Enhancement"
        component={EnhancementScreen}
        options={{
          title: 'Speech Enhancement',
        }}
      />
      <Stack.Screen
        name="EnhancementStreaming"
        component={EnhancementStreamingScreen}
        options={{
          title: 'Speech Enhancement (Streaming)',
        }}
      />
      <Stack.Screen
        name="Separation"
        component={SeparationScreen}
        options={{
          title: 'Source Separation',
        }}
      />
      <Stack.Screen
        name="Settings"
        component={SettingsScreen}
        options={{
          title: 'Settings',
        }}
      />
      <Stack.Screen
        name="FileIO"
        component={FileIOScreen}
        options={{
          title: 'File I/O',
        }}
      />
      <Stack.Screen
        name="AudioVisualization"
        component={AudioVisualizationScreen}
        options={{
          title: 'Audio Visualization',
        }}
      />
    </Stack.Navigator>
  );
}
