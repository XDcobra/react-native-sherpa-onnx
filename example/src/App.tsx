import { NavigationContainer } from '@react-navigation/native';
import { StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import RootNavigator from './navigation/RootNavigator';
import AdsBanner from './ads/AdsBanner';

export default function App() {
  return (
    <SafeAreaProvider>
      <View style={styles.container}>
        <View style={styles.content}>
          <NavigationContainer>
            <RootNavigator />
          </NavigationContainer>
        </View>
        <AdsBanner />
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    flex: 1,
  },
});
