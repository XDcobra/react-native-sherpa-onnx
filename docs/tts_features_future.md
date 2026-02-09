Gute Frage! Lass mich die wichtigsten TTS-Features von sherpa-onnx mit unserer aktuellen Implementierung vergleichen:

## ✅ Was wir bereits unterstützen

1. **Model-Initialisierung** - `initializeTTS()`
2. **Text-to-Speech Generation** - `generateSpeech()`
3. **WAV-Datei speichern** - `saveAudioToFile()` / `saveAudioToContentUri()`
4. **Model-Informationen** - `getModelInfo()` (Sample Rate, Num Speakers)
5. **Ressourcen freigeben** - `unloadTTS()`
6. **Multi-Speaker Support** - `sid` Parameter in `generateSpeech()`
7. **Speed Control** - `speed` Parameter in `generateSpeech()`
8. **Subtitle/Timestamps (estimated)** - `generateSpeechWithTimestamps()`

## ❌ Was sherpa-onnx bietet, wir aber NICHT unterstützen
### 2. **Batch Generation (Multiple Texts)**
```cpp
std::vector<GeneratedAudio> audios = tts->Generate({"Hello", "World", "!"});
```

**Nutzen:** Effizienter für mehrere kurze Texte.

---

### 3. **SSML Support (für manche Modelle)**
```xml
<speak>
  <prosody rate="slow" pitch="+2st">Hello</prosody>
  <break time="500ms"/>
  World!
</speak>
```

**Nutzen:** Feinere Kontrolle über Betonung, Pausen, Pitch.

---

### 4. **Speaker Embedding Customization**
```cpp
// Für Kokoro/Kitten: Custom speaker embeddings laden
config.model.kokoro.speaker_embedding = customEmbeddingFile;
```

**Nutzen:** Eigene Voice-Clones/Custom Voices.

---

### 5. **Audio Format Control**
```cpp
// Aktuell: Nur WAV mit 16-bit PCM
// Möglich: MP3, OGG, FLAC Export
```

**Nutzen:** Kleinere Dateien, breitere Kompatibilität.

---

### 6. **Real-time Factor (RTF) Messung**
```cpp
// Performance-Metrik: Wie schnell vs. Echtzeit
float rtf = audio.real_time_factor;
```

**Nutzen:** Performance-Monitoring, Optimierung.

---

## 🎯 Empfehlungen für nächste Features

**Priorität HOCH (stark nachgefragt):**
2. **Audio Callback** - Progressive Playback

**Priorität MITTEL:**

4. **Batch Generation** - Performance-Optimierung
5. **RTF Messung** - Performance-Monitoring
6. **SSML Support** - Feinere Sprechsteuerung

**Priorität NIEDRIG (Nische):**

7. **Custom Speaker Embeddings** - Voice Cloning (fortgeschritten)
8. **Andere Audio-Formate** - MP3/OGG Export

---

## 📊 Was fehlt am meisten?

Basierend auf typischen TTS-Use-Cases würde ich sagen:

**Top 2 fehlende Features:**

1. **🟡 Audio Callback** - Progressive Playback
2. **🔵 Batch Generation** - Effizienz bei mehreren Texten

Soll ich eines dieser Features implementieren? Ich würde mit **Streaming TTS** anfangen, da es den größten Impact hat.