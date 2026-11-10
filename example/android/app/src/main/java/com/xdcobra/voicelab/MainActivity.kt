package com.xdcobra.voiceexample

import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  /**
   * Pass null to prevent fragment state restoration. react-native-screens does not support
   * restoring Screen fragments; without this, the app can crash on launch when the system
   * tries to restore the fragment state (e.g. after process death or from background).
   * See: https://github.com/software-mansion/react-native-screens/issues/17
   */
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "VoiceLabOfflineTools"

  /**
   * New Architecture / Fabric is enabled via gradle `newArchEnabled` + app load path,
   * not via constructor flags (RN 0.87 deprecated the flag overload).
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName)
}
