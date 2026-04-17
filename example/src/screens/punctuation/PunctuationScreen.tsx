import { View, Text, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@react-native-vector-icons/ionicons';
import { ScreenIntroModal } from '../../components/ScreenIntroModal';

export default function PunctuationScreen() {
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Ionicons name="text-outline" size={72} style={styles.icon} />
        <Text style={styles.title}>Punctuation</Text>
        <Text style={styles.subtitle}>Coming Soon</Text>
        <Text style={styles.description}>
          This placeholder will become the punctuation restoration screen for
          STT output.
        </Text>
        <View style={styles.featureList}>
          <Text style={styles.featureItem}>
            - Restore punctuation in plain text
          </Text>
          <Text style={styles.featureItem}>
            - Improve readability for transcripts
          </Text>
          <Text style={styles.featureItem}>
            - Support long-form text processing
          </Text>
          <Text style={styles.featureItem}>- Export punctuated result</Text>
        </View>
      </View>
      <ScreenIntroModal screenId="Punctuation" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F2F2F7',
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  icon: {
    marginBottom: 24,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#000000',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 20,
    fontWeight: '600',
    color: '#FF9500',
    marginBottom: 24,
  },
  description: {
    fontSize: 16,
    color: '#8E8E93',
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 32,
  },
  featureList: {
    alignSelf: 'stretch',
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 20,
  },
  featureItem: {
    fontSize: 15,
    color: '#000000',
    marginBottom: 12,
    lineHeight: 22,
  },
});
