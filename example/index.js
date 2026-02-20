import { AppRegistry, Platform } from 'react-native';
import {
  getCrashlytics,
  setAttributes,
  log,
} from '@react-native-firebase/crashlytics';
import App from './src/App';
import { name as appName } from './app.json';

// Crashlytics: set attributes and breadcrumb before any app code runs (modular API, v22).
// The @react-native-firebase/crashlytics module already installs a global JS exception handler.
(async function initCrashlytics() {
  try {
    const crashlytics = getCrashlytics();
    await setAttributes(crashlytics, {
      platform: Platform.OS,
      buildType: __DEV__ ? 'debug' : 'release',
    });
    log(crashlytics, 'App started');
  } catch (e) {
    // Firebase not configured or native module not ready (e.g. missing google-services.json).
    if (__DEV__) {
      console.warn('Crashlytics init skipped:', e?.message ?? e);
    }
  }
})();

AppRegistry.registerComponent(appName, () => App);
