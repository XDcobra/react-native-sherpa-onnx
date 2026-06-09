package com.sherpaonnx.tts.system

import android.speech.tts.TextToSpeech
import android.speech.tts.Voice
import java.util.Locale
import java.util.MissingResourceException

internal class SystemTtsVoiceRegistry(
  private val config: SystemTtsConfig,
) {
  private val localeTagByHint: Map<String, String> = config.localeTagByHint
  private val iso3CountryToIso2: Map<String, String> =
    SystemTtsLocaleMapping.buildIso3CountryToIso2(localeTagByHint)
  private val voicesByBaseName: Map<String, SystemTtsVoiceDescriptor> =
    config.voiceDescriptors.associateBy { it.voiceName }
  private val hints: List<String> =
    SystemTtsLocaleMapping.normalizeHints(config.languageHints, localeTagByHint)
  private val locales: List<Locale> =
    hints.map { SystemTtsLocaleMapping.localeForHint(it, localeTagByHint) }
  private val sidByRegisteredVoiceName: Map<String, Int> = buildSidByRegisteredVoiceName()

  /** ISO 639-2/T voice strings for [android.speech.tts.TextToSpeech.Engine.EXTRA_AVAILABLE_VOICES]. */
  fun checkVoiceDataStrings(): List<String> =
    hints.map { SystemTtsLocaleMapping.ttsCheckVoiceDataStringForHint(it, localeTagByHint) }

  fun sampleTextForRequest(lang: String?, country: String?, variant: String?): String? {
    val hint = synthesisLangForRequest(lang, country) ?: return null
    return config.sampleTextByHint[hint]?.trim()?.takeIf { it.isNotEmpty() }
  }

  fun matchesCheckVoiceDataEntry(entry: String): Boolean {
    if (entry.isBlank()) {
      return false
    }
    val parts = entry.trim().split("-")
    return languageAvailability(
      parts.getOrNull(0),
      parts.getOrNull(1),
      parts.getOrNull(2).orEmpty(),
    ) != TextToSpeech.LANG_NOT_SUPPORTED
  }

  fun resolveCheckVoiceDataEntry(requested: String, supported: List<String>): String? {
    if (!matchesCheckVoiceDataEntry(requested)) {
      return null
    }
    supported.firstOrNull { it.equals(requested, ignoreCase = true) }?.let { return it }
    // Android CHECK_TTS_DATA often queries language-only ISO-639-2/T (e.g. "deu").
    val requestedParts = requested.trim().split("-")
    return supported.firstOrNull { canonical ->
      val canonicalParts = canonical.split("-")
      canonicalParts
        .first()
        .equals(requestedParts.first(), ignoreCase = true) &&
        (requestedParts.size < 2 ||
          (canonicalParts.size >= 2 &&
            canonicalParts[1].equals(requestedParts[1], ignoreCase = true)))
    }
  }

  /** One voice per configured locale for [android.speech.tts.TextToSpeechService.onGetVoices]. */
  fun catalogVoices(): List<Voice> {
    val out = ArrayList<Voice>(locales.size)
    for (locale in locales) {
      val voiceName = locale.toLanguageTag()
      out.add(
        Voice(
          voiceName,
          locale,
          Voice.QUALITY_NORMAL,
          Voice.LATENCY_NORMAL,
          false,
          emptySet(),
        ),
      )
    }
    return out
  }

  fun isValidVoiceName(voiceName: String): Boolean =
    sidByRegisteredVoiceName.containsKey(voiceName) || isSupportedLocaleTag(voiceName)

  fun resolveSid(voiceName: String, preferredBaseVoiceName: String?): Int? {
    sidByRegisteredVoiceName[voiceName]?.let { return it }
    if (!isSupportedLocaleTag(voiceName)) {
      return null
    }
    val baseName =
      preferredBaseVoiceName
        ?.let { baseVoiceName(it) }
        ?.takeIf { voicesByBaseName.containsKey(it) }
        ?: config.defaultVoiceName.takeIf { voicesByBaseName.containsKey(it) }
        ?: return null
    return voicesByBaseName[baseName]?.sid
  }

  /** BCP-47 locale tag (e.g. `de-DE`) for AOSP voice listing. */
  fun defaultLocaleTagFor(lang: String?, country: String?, variant: String?): String {
    val status = languageAvailability(lang, country, variant)
    if (status == TextToSpeech.LANG_NOT_SUPPORTED) {
      return ""
    }
    val matchedHint =
      hints.firstOrNull {
        SystemTtsLocaleMapping.requestMatchesHint(
          lang,
          country,
          it,
          localeTagByHint,
          iso3CountryToIso2,
        )
      }
        ?: return ""
    return SystemTtsLocaleMapping.localeForHint(matchedHint, localeTagByHint).toLanguageTag()
  }

  fun languageAvailability(lang: String?, country: String?, variant: String?): Int {
    if (hints.isEmpty()) {
      return TextToSpeech.LANG_NOT_SUPPORTED
    }

    val normalizedLang = SystemTtsLocaleMapping.normalizeTtsLanguageCode(lang)
      ?: return TextToSpeech.LANG_NOT_SUPPORTED
    val normalizedCountry =
      SystemTtsLocaleMapping.normalizeTtsCountryCode(country, iso3CountryToIso2)
    val normalizedVariant = variant?.trim().orEmpty()

    val languageSupported =
      hints.any { hint -> languageMatchesHint(normalizedLang, hint) }
    if (!languageSupported) {
      return TextToSpeech.LANG_NOT_SUPPORTED
    }

    val countrySupported =
      hints.any { hint ->
        languageMatchesHint(normalizedLang, hint) &&
          !normalizedCountry.isNullOrBlank() &&
          countryMatchesHint(normalizedCountry, hint)
      }

    return when {
      normalizedVariant.isNotEmpty() && countrySupported ->
        TextToSpeech.LANG_COUNTRY_VAR_AVAILABLE
      !normalizedCountry.isNullOrBlank() && countrySupported ->
        TextToSpeech.LANG_COUNTRY_AVAILABLE
      normalizedCountry.isNullOrBlank() && normalizedVariant.isEmpty() ->
        TextToSpeech.LANG_AVAILABLE
      else ->
        TextToSpeech.LANG_NOT_SUPPORTED
    }
  }

  fun synthesisLangForRequest(lang: String?, country: String?): String? =
    hints.firstOrNull {
      SystemTtsLocaleMapping.requestMatchesHint(
        lang,
        country,
        it,
        localeTagByHint,
        iso3CountryToIso2,
      )
    }

  private fun isSupportedLocaleTag(voiceName: String): Boolean {
    val locale = Locale.forLanguageTag(voiceName)
    val iso3Lang = safeIso3Language(locale) ?: return false
    val iso3Country = safeIso3Country(locale)
    return languageAvailability(iso3Lang, iso3Country, locale.variant) !=
      TextToSpeech.LANG_NOT_SUPPORTED
  }

  private fun languageMatchesHint(normalizedLang: String, hint: String): Boolean {
    val target = SystemTtsLocaleMapping.localeForHint(hint, localeTagByHint)
    return normalizedLang.equals(target.language, ignoreCase = true)
  }

  private fun countryMatchesHint(normalizedCountry: String, hint: String): Boolean {
    val target = SystemTtsLocaleMapping.localeForHint(hint, localeTagByHint)
    return target.country.isNotEmpty() &&
      normalizedCountry.equals(target.country, ignoreCase = true)
  }

  private fun buildSidByRegisteredVoiceName(): Map<String, Int> {
    val out = LinkedHashMap<String, Int>()
    for (locale in locales) {
      for (descriptor in config.voiceDescriptors) {
        out[registeredVoiceName(descriptor, locale)] = descriptor.sid
      }
    }
    return out
  }

  private fun registeredVoiceName(descriptor: SystemTtsVoiceDescriptor, locale: Locale): String =
    "${descriptor.voiceName}__${locale.toLanguageTag()}"

  private fun baseVoiceName(voiceName: String): String = voiceName.substringBefore("__")

  private fun safeIso3Language(locale: Locale): String? =
    try {
      locale.isO3Language.takeIf { it.isNotEmpty() }
    } catch (_: MissingResourceException) {
      null
    }

  private fun safeIso3Country(locale: Locale): String? =
    try {
      locale.isO3Country.takeIf { it.isNotEmpty() }
    } catch (_: MissingResourceException) {
      null
    }
}
