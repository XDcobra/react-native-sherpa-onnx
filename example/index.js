import { AppRegistry, Platform } from 'react-native';
import crashlytics from '@react-native-firebase/crashlytics';
import App from './src/App';
import { name as appName } from './app.json';

// Crashlytics: set attributes and breadcrumb before any app code runs.
// The @react-native-firebase/crashlytics module already installs a global JS exception handler.
(function initCrashlytics() {
  try {
    crashlytics().setAttributes({
      platform: Platform.OS,
      buildType: __DEV__ ? 'debug' : 'release',
    });
    crashlytics().log('App started');
  } catch (e) {
    // Firebase not configured or native module not ready (e.g. missing google-services.json).
    if (__DEV__) {
      console.warn('Crashlytics init skipped:', e?.message ?? e);
    }
  }
})();

AppRegistry.registerComponent(appName, () => App);
