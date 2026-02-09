Gute Frage! Lass mich die wichtigsten TTS-Features von sherpa-onnx mit unserer aktuellen Implementierung vergleichen:

## ✅ Was wir bereits unterstützen

1. **Model-Initialisierung** - `initializeTTS()`
2. **Text-to-Speech Generation** - `generateSpeech()`
3. **WAV-Datei speichern** - `saveAudioToFile()` / `saveAudioToContentUri()`
4. **Model-Informationen** - `getModelInfo()` (Sample Rate, Num Speakers)
5. **Ressourcen freigeben** - `unloadTTS()`
6. **Multi-Speaker Support** - `sid` Parameter in `generateSpeech()`
7. **Speed Control** - `speed` Parameter in `generateSpeech()`

## ❌ Was sherpa-onnx bietet, wir aber NICHT unterstützen

### 1. **Streaming TTS (Online TTS)**
```cpp
// sherpa-onnx bietet auch streaming/chunked generation
OnlineTts tts = OnlineTts::Create(config);
tts.GenerateSubtitle(text);  // Gibt Text + Timestamps zurück
```

**Nutzen:** Echtzeit-TTS mit sofortigem Audio-Start (wichtig für lange Texte)

---

### 2. **Audio Streaming Callback**
```cpp
// Callback während Generation für progressive Wiedergabe
OfflineTtsGeneratedAudioCallbackWithArg callback;
config.callback = callback;
```

**Nutzen:** Audio abspielen während es generiert wird (bessere UX)

---

### 3. **Subtitle/Timestamp Generation**
```cpp
OfflineTtsGeneratedAudio audio = tts->Generate(text);
// audio enthält auch timestamps für jedes Wort/Phonem
```

**Nutzen:** Lippensynchronisation, Karaoke-Style Text-Highlighting

---

### 4. **Batch Generation (Multiple Texts)**
```cpp
std::vector<GeneratedAudio> audios = tts->Generate({"Hello", "World", "!"});
```

**Nutzen:** Effizienter für mehrere kurze Texte

---

### 5. **SSML Support (für manche Modelle)**
```xml
<speak>
  <prosody rate="slow" pitch="+2st">Hello</prosody>
  <break time="500ms"/>
  World!
</speak>
```

**Nutzen:** Feinere Kontrolle über Betonung, Pausen, Pitch

---

### 6. **Speaker Embedding Customization**
```cpp
// Für Kokoro/Kitten: Custom speaker embeddings laden
config.model.kokoro.speaker_embedding = customEmbeddingFile;
```

**Nutzen:** Eigene Voice-Clones/Custom Voices

---

### 7. **Audio Format Control**
```cpp
// Aktuell: Nur WAV mit 16-bit PCM
// Möglich: MP3, OGG, FLAC Export
```

**Nutzen:** Kleinere Dateien, breitere Kompatibilität

---

### 8. **Noise/Length Scale Parameter**
```cpp
// Für VITS/Matcha Modelle
config.model.vits.noise_scale = 0.667;
config.model.vits.length_scale = 1.0;
```

**Nutzen:** Audio-Qualität tunen (Natürlichkeit vs. Klarheit)

---

### 9. **Real-time Factor (RTF) Messung**
```cpp
// Performance-Metrik: Wie schnell vs. Echtzeit
float rtf = audio.real_time_factor;
```

**Nutzen:** Performance-Monitoring, Optimierung

---

## 🎯 Empfehlungen für nächste Features

**Priorität HOCH (stark nachgefragt):**

1. **Streaming TTS** - Für lange Texte/Echtzeit-Apps
2. **Subtitle/Timestamps** - Für Lippensync/UI-Highlighting
3. **Noise/Length Scale** - Für Audio-Qualität-Tuning

**Priorität MITTEL:**

4. **Batch Generation** - Performance-Optimierung
5. **RTF Messung** - Performance-Monitoring
6. **Audio Callback** - Progressive Playback

**Priorität NIEDRIG (Nische):**

7. **SSML Support** - Nur für spezielle Use Cases
8. **Custom Speaker Embeddings** - Voice Cloning (fortgeschritten)
9. **Andere Audio-Formate** - MP3/OGG Export

---

## 📊 Was fehlt am meisten?

Basierend auf typischen TTS-Use-Cases würde ich sagen:

**Top 3 fehlende Features:**

1. **🔴 Streaming/Online TTS** - Game-changer für UX
2. **🟡 Timestamps/Subtitles** - Wichtig für Sync-Apps
3. **🟡 Noise/Length Scale** - Audio-Qualität verbessern

Soll ich eines dieser Features implementieren? Ich würde mit **Streaming TTS** oder **Noise/Length Scale Parameter** anfangen, da sie den größten Impact haben.