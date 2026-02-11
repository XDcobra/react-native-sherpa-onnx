import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../types/navigation';

import HomeScreen from '../screens/home/HomeScreen';
import STTScreen from '../screens/stt/STTScreen';
import TTSScreen from '../screens/tts/TTSScreen';
import VADScreen from '../screens/vad/VADScreen';
import DiarizationScreen from '../screens/diarization/DiarizationScreen';
import EnhancementScreen from '../screens/enhancement/EnhancementScreen';
import SeparationScreen from '../screens/separation/SeparationScreen';
import SettingsScreen from '../screens/settings/SettingsScreen';
import ModelManagementScreen from '../screens/download/ModelManagementScreen';

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
        name="TTS"
        component={TTSScreen}
        options={{
          title: 'Text-to-Speech',
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
        name="Diarization"
        component={DiarizationScreen}
        options={{
          title: 'Speaker Diarization',
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
        name="ModelManagement"
        component={ModelManagementScreen}
        options={{
          title: 'Model Management',
        }}
      />
    </Stack.Navigator>
  );
}
