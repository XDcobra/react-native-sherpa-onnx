#include "TtsEngineStore.h"

std::unordered_map<std::string, std::shared_ptr<TtsInstanceState>> g_tts_instances;
std::mutex g_tts_mutex;
std::condition_variable g_tts_stream_cv;
