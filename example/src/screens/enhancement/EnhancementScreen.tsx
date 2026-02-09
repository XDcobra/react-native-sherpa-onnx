import { View, Text, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@react-native-vector-icons/ionicons';

export default function EnhancementScreen() {
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Ionicons name="options" size={72} style={styles.icon} />
        <Text style={styles.title}>Speech Enhancement</Text>
        <Text style={styles.subtitle}>Coming Soon</Text>
        <Text style={styles.description}>
          This feature will remove noise and improve audio quality for better
          speech recognition.
        </Text>
        <View style={styles.featureList}>
          <Text style={styles.featureItem}>• Noise reduction</Text>
          <Text style={styles.featureItem}>• Echo cancellation</Text>
          <Text style={styles.featureItem}>• Audio normalization</Text>
          <Text style={styles.featureItem}>• Before/after comparison</Text>
        </View>
      </View>
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
