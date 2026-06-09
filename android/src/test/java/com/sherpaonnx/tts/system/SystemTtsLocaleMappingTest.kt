package com.sherpaonnx.tts.system

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SystemTtsLocaleMappingTest {
  private val localeTagByHint =
    mapOf(
      "en" to "en-US",
      "de" to "de-DE",
      "fr" to "fr-FR",
    )

  @Test
  fun normalizeHints_dropsNaAndAuto() {
    assertEquals(
      listOf("en", "de"),
      SystemTtsLocaleMapping.normalizeHints(
        listOf("en", "na", "auto", "de"),
        localeTagByHint,
      ),
    )
  }

  @Test(expected = IllegalArgumentException::class)
  fun normalizeHints_rejectsUnknownHint() {
    SystemTtsLocaleMapping.normalizeHints(listOf("zz"), localeTagByHint)
  }

  @Test
  fun localeForHint_mapsGerman() {
    assertEquals("de", SystemTtsLocaleMapping.localeForHint("de", localeTagByHint).language)
    assertEquals("DE", SystemTtsLocaleMapping.localeForHint("de", localeTagByHint).country)
  }

  @Test
  fun requestMatchesHint_acceptsPrimaryLanguage() {
    assertTrue(
      SystemTtsLocaleMapping.requestMatchesHint(
        "de",
        "DE",
        "de",
        localeTagByHint,
        SystemTtsLocaleMapping.buildIso3CountryToIso2(localeTagByHint),
      ),
    )
    assertFalse(
      SystemTtsLocaleMapping.requestMatchesHint(
        "fr",
        "FR",
        "de",
        localeTagByHint,
        SystemTtsLocaleMapping.buildIso3CountryToIso2(localeTagByHint),
      ),
    )
  }

  @Test
  fun requestMatchesHint_acceptsAndroidIso3Codes() {
    val iso3CountryToIso2 = SystemTtsLocaleMapping.buildIso3CountryToIso2(localeTagByHint)
    assertTrue(
      SystemTtsLocaleMapping.requestMatchesHint(
        "deu",
        "DEU",
        "de",
        localeTagByHint,
        iso3CountryToIso2,
      ),
    )
    assertTrue(
      SystemTtsLocaleMapping.requestMatchesHint(
        "eng",
        "USA",
        "en",
        localeTagByHint,
        iso3CountryToIso2,
      ),
    )
    assertFalse(
      SystemTtsLocaleMapping.requestMatchesHint(
        "fra",
        "FRA",
        "de",
        localeTagByHint,
        iso3CountryToIso2,
      ),
    )
  }

  @Test
  fun ttsLanguageTripleForHint_usesIso3Codes() {
    val triple = SystemTtsLocaleMapping.ttsLanguageTripleForHint("de", localeTagByHint)
    assertEquals("deu", triple[0])
    assertEquals("DEU", triple[1])
  }

  @Test
  fun normalizeTtsLanguageCode_usesExplicitIso3Map() {
    assertEquals("de", SystemTtsLocaleMapping.normalizeTtsLanguageCode("deu"))
    assertEquals("en", SystemTtsLocaleMapping.normalizeTtsLanguageCode("eng"))
    assertNull(SystemTtsLocaleMapping.normalizeTtsLanguageCode("zzz"))
  }

  @Test
  fun ttsCheckVoiceDataStringForHint_usesIso3VoiceFormat() {
    assertEquals(
      "deu-DEU",
      SystemTtsLocaleMapping.ttsCheckVoiceDataStringForHint("de", localeTagByHint),
    )
    assertEquals(
      "eng-USA",
      SystemTtsLocaleMapping.ttsCheckVoiceDataStringForHint("en", localeTagByHint),
    )
  }
}
