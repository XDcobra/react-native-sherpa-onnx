package com.sherpaonnx.tts.system

import java.util.Locale
import java.util.MissingResourceException

/** ISO 639-2/T ↔ ISO 639-1 helpers for Android [android.speech.tts.TextToSpeechService]. */
object SystemTtsLocaleMapping {
  /** ISO 639-2/T → ISO 639-1 for Android TTS ISO-3 language codes. */
  private val iso3LanguageToIso1 =
    mapOf(
      "ara" to "ar",
      "bul" to "bg",
      "hrv" to "hr",
      "ces" to "cs",
      "dan" to "da",
      "nld" to "nl",
      "eng" to "en",
      "est" to "et",
      "fin" to "fi",
      "fra" to "fr",
      "deu" to "de",
      "ell" to "el",
      "hin" to "hi",
      "hun" to "hu",
      "ind" to "id",
      "ita" to "it",
      "jpn" to "ja",
      "kor" to "ko",
      "lav" to "lv",
      "lit" to "lt",
      "pol" to "pl",
      "por" to "pt",
      "ron" to "ro",
      "rus" to "ru",
      "slk" to "sk",
      "slv" to "sl",
      "spa" to "es",
      "swe" to "sv",
      "tur" to "tr",
      "ukr" to "uk",
      "vie" to "vi",
    )

  fun localeForHint(hint: String, localeTagByHint: Map<String, String>): Locale {
    val normalized = hint.trim().lowercase(Locale.US)
    val tag =
      localeTagByHint[normalized]
        ?: throw IllegalArgumentException("missing locale tag for hint: $hint")
    return Locale.forLanguageTag(tag)
  }

  fun normalizeHints(
    hints: List<String>,
    localeTagByHint: Map<String, String>,
  ): List<String> {
    val out = LinkedHashSet<String>()
    for (raw in hints) {
      val hint = raw.trim().lowercase(Locale.US)
      if (hint.isEmpty() || hint == "na" || hint == "auto") {
        continue
      }
      if (!localeTagByHint.containsKey(hint)) {
        throw IllegalArgumentException("missing locale tag for detect hint: $hint")
      }
      out.add(hint)
    }
    return out.toList()
  }

  fun buildIso3CountryToIso2(localeTagByHint: Map<String, String>): Map<String, String> {
    val out = LinkedHashMap<String, String>()
    for (tag in localeTagByHint.values) {
      val locale = Locale.forLanguageTag(tag)
      val iso3 = safeIso3Country(locale) ?: continue
      val iso2 = locale.country.uppercase(Locale.US)
      if (iso2.length == 2) {
        out.putIfAbsent(iso3.uppercase(Locale.US), iso2)
      }
    }
    return out
  }

  /**
   * Android [android.speech.tts.TextToSpeechService] passes ISO 639-2/T (3-letter) language and
   * ISO 3166 alpha-3 country codes. Model hints are ISO 639-1.
   */
  fun normalizeTtsLanguageCode(lang: String?): String? {
    if (lang.isNullOrBlank()) {
      return null
    }
    val code = lang.trim().lowercase(Locale.US)
    if (code.length == 2) {
      return code
    }
    if (code.length == 3) {
      return iso3LanguageToIso1[code]
    }
    return null
  }

  fun normalizeTtsCountryCode(
    country: String?,
    iso3CountryToIso2: Map<String, String>,
  ): String? {
    if (country.isNullOrBlank()) {
      return null
    }
    val code = country.trim()
    if (code.length == 2) {
      return code.uppercase(Locale.US)
    }
    if (code.length == 3) {
      return iso3CountryToIso2[code.uppercase(Locale.US)]
    }
    return null
  }

  fun requestMatchesHint(
    lang: String?,
    country: String?,
    hint: String,
    localeTagByHint: Map<String, String>,
    iso3CountryToIso2: Map<String, String>,
  ): Boolean {
    val normalizedLang = normalizeTtsLanguageCode(lang) ?: return false
    val normalizedCountry = normalizeTtsCountryCode(country, iso3CountryToIso2)
    val target = localeForHint(hint, localeTagByHint)
    if (!normalizedLang.equals(target.language, ignoreCase = true)) {
      return false
    }
    if (!normalizedCountry.isNullOrBlank() && target.country.isNotEmpty()) {
      return normalizedCountry.equals(target.country, ignoreCase = true)
    }
    return true
  }

  /** ISO 639-2/T + ISO 3166 alpha-3 triple for [android.speech.tts.TextToSpeechService.onGetLanguage]. */
  fun ttsLanguageTripleForHint(
    hint: String,
    localeTagByHint: Map<String, String>,
  ): Array<String> {
    val locale = localeForHint(hint, localeTagByHint)
    val iso3Lang =
      safeIso3Language(locale)
        ?: throw IllegalStateException("missing ISO-639-2/T for hint=$hint tag=${locale.toLanguageTag()}")
    val iso3Country = safeIso3Country(locale).orEmpty()
    return arrayOf(iso3Lang, iso3Country, locale.variant.ifEmpty { "" })
  }

  /**
   * Voice entry for [android.speech.tts.TextToSpeech.Engine.ACTION_CHECK_TTS_DATA]
   * (`EXTRA_AVAILABLE_VOICES`), e.g. `deu-DEU`.
   */
  fun ttsCheckVoiceDataStringForHint(
    hint: String,
    localeTagByHint: Map<String, String>,
  ): String {
    val triple = ttsLanguageTripleForHint(hint, localeTagByHint)
    val out = StringBuilder(triple[0])
    if (triple[1].isNotEmpty()) {
      out.append('-').append(triple[1])
    }
    if (triple[2].isNotEmpty()) {
      out.append('-').append(triple[2])
    }
    return out.toString()
  }

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
