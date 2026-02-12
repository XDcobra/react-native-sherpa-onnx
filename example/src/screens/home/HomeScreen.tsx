import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import type { ComponentProps } from 'react';
import { StatusBar } from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList, Feature } from '../../types/navigation';

const FEATURES: Feature[] = [
  {
    id: 'stt',
    title: 'Speech-to-Text',
    description: 'Convert speech to text using offline models',
    icon: 'mic',
    screen: 'STT',
    implemented: true,
  },
  {
    id: 'tts',
    title: 'Text-to-Speech',
    description: 'Generate speech from text',
    icon: 'volume-high',
    screen: 'TTS',
    implemented: true,
  },
  {
    id: 'vad',
    title: 'Voice Activity Detection',
    description: 'Detect voice activity in audio streams',
    icon: 'stats-chart',
    screen: 'VAD',
    implemented: false,
  },
  {
    id: 'diarization',
    title: 'Speaker Diarization',
    description: 'Identify who spoke when in audio',
    icon: 'people',
    screen: 'Diarization',
    implemented: false,
  },
  {
    id: 'enhancement',
    title: 'Speech Enhancement',
    description: 'Remove noise and improve audio quality',
    icon: 'options',
    screen: 'Enhancement',
    implemented: false,
  },
  {
    id: 'separation',
    title: 'Source Separation',
    description: 'Separate voice from background music',
    icon: 'musical-notes',
    screen: 'Separation',
    implemented: false,
  },
];

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Home'>;
};

export default function HomeScreen({ navigation }: Props) {
  const renderFeatureCard = ({ item }: { item: Feature }) => (
    <TouchableOpacity
      style={[styles.card, !item.implemented && styles.cardDisabled]}
      onPress={() => navigation.navigate(item.screen)}
      activeOpacity={0.7}
    >
      <View style={styles.cardContent}>
        <Ionicons
          name={item.icon as ComponentProps<typeof Ionicons>['name']}
          size={36}
          style={styles.icon}
        />
        <View style={styles.textContainer}>
          <View style={styles.titleRow}>
            <Text
              style={[styles.title, !item.implemented && styles.textDisabled]}
            >
              {item.title}
            </Text>
            {!item.implemented && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>Coming Soon</Text>
              </View>
            )}
          </View>
          <Text
            style={[
              styles.description,
              !item.implemented && styles.textDisabled,
            ]}
          >
            {item.description}
          </Text>
        </View>
        <Text style={styles.chevron}>›</Text>
      </View>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar backgroundColor="#FFFFFF" barStyle="dark-content" />
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <Text style={styles.headerTitle}>Voice Lab - Offline Tools</Text>
          <View style={styles.headerActions}>
            <TouchableOpacity
              style={styles.settingsButton}
              onPress={() => navigation.navigate('ModelManagement')}
              activeOpacity={0.7}
            >
              <Ionicons name="download-outline" size={22} color="#007AFF" />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.settingsButton}
              onPress={() => navigation.navigate('Settings')}
              activeOpacity={0.7}
            >
              <Ionicons name="settings-outline" size={22} color="#007AFF" />
            </TouchableOpacity>
          </View>
        </View>
        <Text style={styles.headerSubtitle}>
          Offline speech processing on device
        </Text>
      </View>
      <View style={styles.body}>
        <FlatList
          data={FEATURES}
          renderItem={renderFeatureCard}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F2F2F7',
  },
  body: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 16,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E5EA',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#000000',
    marginBottom: 4,
  },
  settingsButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerSubtitle: {
    fontSize: 14,
    color: '#8E8E93',
  },
  listContent: {
    padding: 16,
    paddingBottom: 32,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 3,
  },
  cardDisabled: {
    opacity: 0.65,
  },
  cardContent: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
  },
  icon: {
    marginRight: 16,
  },
  textContainer: {
    flex: 1,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  title: {
    fontSize: 17,
    fontWeight: '600',
    color: '#000000',
    marginRight: 8,
  },
  textDisabled: {
    color: '#C7C7CC',
  },
  description: {
    fontSize: 14,
    color: '#8E8E93',
    lineHeight: 18,
  },
  badge: {
    backgroundColor: '#FF9500',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  chevron: {
    fontSize: 28,
    color: '#C7C7CC',
    marginLeft: 8,
  },
});
