package sherpaonnx.example

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule

class AdsConfigModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "AdsConfig"

  override fun getConstants(): MutableMap<String, Any> {
    val constants = HashMap<String, Any>()
    constants["ADS_ENABLED"] = BuildConfig.ADS_ENABLED
    constants["ADMOB_BANNER_ID_ANDROID"] = BuildConfig.ADMOB_BANNER_ID_ANDROID
    return constants
  }
}
