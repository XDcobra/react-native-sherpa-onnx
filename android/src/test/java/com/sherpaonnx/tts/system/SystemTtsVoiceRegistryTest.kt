package com.sherpaonnx.tts.system

import android.speech.tts.TextToSpeech
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SystemTtsVoiceRegistryTest {
  private val localeTagByHint =
    mapOf(
      "en" to "en-US",
      "de" to "de-DE",
      "fr" to "fr-FR",
    )

  private val registry =
    SystemTtsVoiceRegistry(
      SystemTtsConfig(
        modelDir = "/tmp/model",
        modelType = "supertonic",
        paths = emptyMap(),
        languageHints = listOf("en", "de", "fr"),
        localeTagByHint = localeTagByHint,
        voiceDescriptors =
          listOf(
            SystemTtsVoiceDescriptor("voicelab_supertonic_f1", 0, "VoiceLab F1"),
          ),
        defaultVoiceName = "voicelab_supertonic_f1",
        sampleTextByHint =
          mapOf(
            "de" to "Dies ist ein Beispiel für Sprachsynthese.",
            "en" to "This is an example of speech synthesis.",
          ),
      ),
    )

  @Test
  fun languageAvailability_matchesAospIso3CountryGranularity() {
    assertEquals(
      TextToSpeech.LANG_COUNTRY_AVAILABLE,
      registry.languageAvailability("deu", "DEU", ""),
    )
    assertEquals(
      TextToSpeech.LANG_AVAILABLE,
      registry.languageAvailability("deu", "", ""),
    )
  }

  @Test
  fun defaultLocaleTagFor_returnsBcp47Tag() {
    assertEquals("de-DE", registry.defaultLocaleTagFor("deu", "DEU", ""))
  }

  @Test
  fun defaultLocaleTagFor_rejectsUnsupportedLocale() {
    assertEquals("", registry.defaultLocaleTagFor("ita", "ITA", ""))
  }

  @Test
  fun isValidVoiceName_acceptsLocaleTag() {
    assertTrue(registry.isValidVoiceName("de-DE"))
  }

  @Test
  fun languageAvailability_rejectsUnsupportedCountryVariant() {
    assertEquals(
      TextToSpeech.LANG_NOT_SUPPORTED,
      registry.languageAvailability("deu", "AUT", ""),
    )
  }

  @Test
  fun checkVoiceDataStrings_useIso3Format() {
    val voices = registry.checkVoiceDataStrings()
    assertTrue(voices.contains("deu-DEU"))
    assertTrue(voices.contains("eng-USA"))
  }

  @Test
  fun resolveCheckVoiceDataEntry_matchesExactAndLanguageOnlyRequests() {
    val supported = registry.checkVoiceDataStrings()
    assertEquals("deu-DEU", registry.resolveCheckVoiceDataEntry("deu-DEU", supported))
    assertEquals("deu-DEU", registry.resolveCheckVoiceDataEntry("deu", supported))
  }

  @Test
  fun synthesisLangForRequest_matchesRequestOrReturnsNull() {
    assertEquals("de", registry.synthesisLangForRequest("deu", "DEU"))
    assertEquals("de", registry.synthesisLangForRequest("deu", ""))
    assertNull(registry.synthesisLangForRequest("ita", "ITA"))
  }

  @Test
  fun sampleTextForRequest_usesConfigMap() {
    assertEquals(
      "Dies ist ein Beispiel für Sprachsynthese.",
      registry.sampleTextForRequest("deu", "DEU", ""),
    )
    assertNull(registry.sampleTextForRequest("fra", "FRA", ""))
  }

  @Test
  fun resolveSid_usesConfigDefaultVoiceWhenPreferenceMissing() {
    assertEquals(0, registry.resolveSid("de-DE", null))
    assertEquals(
      0,
      registry.resolveSid("de-DE", "voicelab_supertonic_f1"),
    )
  }
}
