#include "NativeDiagnostic.h"

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

#if defined(__ANDROID__)
#include <pthread.h>
#include <sys/prctl.h>
#include <unistd.h>
#elif defined(__APPLE__)
#include <pthread.h>
#include <unistd.h>
#endif

namespace sherpa::diag {

namespace {

std::atomic<bool> g_enabled{true};
std::atomic<bool> g_installSignalHandler{true};
std::atomic<bool> g_signalHandlerInstalled{false};
std::atomic<bool> g_initialized{false};
std::atomic<uint64_t> g_seq{0};
std::atomic<uint32_t> g_head{0};

DiagnosticEntry g_ring[kRingCapacity];
std::atomic<bool> g_crashDumping{false};

void CopyTrunc(char* dst, size_t dstSize, const char* src) {
  if (!dst || dstSize == 0) {
    return;
  }
  if (!src) {
    dst[0] = '\0';
    return;
  }
  std::snprintf(dst, dstSize, "%s", src);
  dst[dstSize - 1] = '\0';
}

uint64_t MonotonicMs() {
  using clock = std::chrono::steady_clock;
  return static_cast<uint64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(clock::now().time_since_epoch())
          .count());
}

uint32_t GetCurrentThreadId() {
#if defined(__ANDROID__)
  return static_cast<uint32_t>(gettid());
#elif defined(__APPLE__)
  uint64_t tid = 0;
  pthread_threadid_np(nullptr, &tid);
  return static_cast<uint32_t>(tid);
#else
  return 0;
#endif
}

void CaptureThreadName(char* out, size_t outSize) {
  if (!out || outSize == 0) {
    return;
  }
  out[0] = '\0';
#if defined(__ANDROID__)
  // pthread_getname_np is not in the NDK for minSdk 24; prctl reads names from pthread_setname_np / Java.
  if (prctl(PR_GET_NAME, out, 0, 0, 0) == 0 && out[0] != '\0') {
    out[outSize - 1] = '\0';
    return;
  }
#elif defined(__APPLE__)
  if (pthread_getname_np(pthread_self(), out, outSize) == 0) {
    out[outSize - 1] = '\0';
    return;
  }
#endif
  std::snprintf(out, outSize, "tid-%u", static_cast<unsigned>(GetCurrentThreadId()));
  out[outSize - 1] = '\0';
}

const char* BasenameOnly(const char* path) {
  if (!path) {
    return nullptr;
  }
  const char* slash = std::strrchr(path, '/');
  if (slash) {
    return slash + 1;
  }
  const char* backslash = std::strrchr(path, '\\');
  if (backslash) {
    return backslash + 1;
  }
  return path;
}

} // namespace

const char* SanitizeDetail(const char* detail, char* scratch, size_t scratchSize) {
  if (!detail || detail[0] == '\0' || !scratch || scratchSize == 0) {
    return nullptr;
  }
  scratch[0] = '\0';

  if (std::strstr(detail, "/") != nullptr || std::strstr(detail, "\\") != nullptr) {
    const char* base = BasenameOnly(detail);
    if (base && base[0] != '\0') {
      CopyTrunc(scratch, scratchSize, base);
      return scratch;
    }
  }

  CopyTrunc(scratch, scratchSize, detail);
  return scratch;
}

void Init(bool installSignalHandler) {
  g_installSignalHandler.store(installSignalHandler);
  g_initialized.store(true);
  if (installSignalHandler) {
    InstallPlatformSignalHandlers();
  }
}

void SetEnabled(bool enabled) { g_enabled.store(enabled); }

bool IsEnabled() { return g_enabled.load(); }

void SetInstallSignalHandler(bool install) {
  g_installSignalHandler.store(install);
  if (install && g_initialized.load() && !g_signalHandlerInstalled.load()) {
    InstallPlatformSignalHandlers();
  }
}

bool IsSignalHandlerInstalled() { return g_signalHandlerInstalled.load(); }

bool InstallSignalHandlerRequested() { return g_installSignalHandler.load(); }

void MarkSignalHandlerInstalled() { g_signalHandlerInstalled.store(true); }

void OnCrashSignal(int signo);

void Record(const char* domain, const char* phase, const char* detail) {
  if (!g_enabled.load()) {
    return;
  }

  char detailScratch[kDetailMax];
  const char* safeDetail = SanitizeDetail(detail, detailScratch, sizeof(detailScratch));

  const uint32_t slot = g_head.fetch_add(1, std::memory_order_relaxed) % kRingCapacity;
  DiagnosticEntry& e = g_ring[slot];

  e.seq = g_seq.fetch_add(1, std::memory_order_relaxed) + 1;
  e.monotonicMs = MonotonicMs();
  e.tid = GetCurrentThreadId();
  CaptureThreadName(e.threadName, sizeof(e.threadName));
  CopyTrunc(e.domain, sizeof(e.domain), domain ? domain : "?");
  CopyTrunc(e.phase, sizeof(e.phase), phase ? phase : "?");
  if (safeDetail) {
    CopyTrunc(e.detail, sizeof(e.detail), safeDetail);
  } else {
    e.detail[0] = '\0';
  }

  LogRecordTrail(e.domain, e.phase, e.detail[0] != '\0' ? e.detail : nullptr);
}

static int CompareEntriesBySeq(const void* a, const void* b) {
  const DiagnosticEntry* ea = static_cast<const DiagnosticEntry*>(a);
  const DiagnosticEntry* eb = static_cast<const DiagnosticEntry*>(b);
  if (ea->seq < eb->seq) {
    return -1;
  }
  if (ea->seq > eb->seq) {
    return 1;
  }
  return 0;
}

DiagnosticSnapshot GetSnapshot() {
  DiagnosticSnapshot snap;
  snap.enabled = g_enabled.load();
  snap.signalHandlerInstalled = g_signalHandlerInstalled.load();

  DiagnosticEntry tmp[kRingCapacity];
  for (int i = 0; i < kRingCapacity; ++i) {
    tmp[i] = g_ring[i];
  }
  qsort(tmp, kRingCapacity, sizeof(DiagnosticEntry), CompareEntriesBySeq);

  int count = 0;
  for (int i = 0; i < kRingCapacity; ++i) {
    if (tmp[i].seq == 0) {
      continue;
    }
    snap.entries[count++] = tmp[i];
  }
  snap.entryCount = count;
  return snap;
}

namespace {

void AppendJsonEscaped(std::string& out, const char* value) {
  if (!value) {
    return;
  }
  for (const char* p = value; *p != '\0'; ++p) {
    const char c = *p;
    if (c == '\\' || c == '"') {
      out += '\\';
    }
    out += c;
  }
}

} // namespace

std::string GetSnapshotJson() {
  const DiagnosticSnapshot snap = GetSnapshot();
  std::string json = "{\"enabled\":";
  json += snap.enabled ? "true" : "false";
  json += ",\"signalHandlerInstalled\":";
  json += snap.signalHandlerInstalled ? "true" : "false";
  json += ",\"entries\":[";
  for (int i = 0; i < snap.entryCount; ++i) {
    const DiagnosticEntry& e = snap.entries[i];
    if (i > 0) {
      json += ',';
    }
    char head[128];
    std::snprintf(
        head,
        sizeof(head),
        "{\"seq\":%llu,\"monotonicMs\":%llu,\"tid\":%u,\"threadName\":\"",
        static_cast<unsigned long long>(e.seq),
        static_cast<unsigned long long>(e.monotonicMs),
        e.tid);
    json += head;
    AppendJsonEscaped(json, e.threadName);
    json += "\",\"domain\":\"";
    AppendJsonEscaped(json, e.domain);
    json += "\",\"phase\":\"";
    AppendJsonEscaped(json, e.phase);
    json += "\",\"detail\":\"";
    AppendJsonEscaped(json, e.detail);
    json += "\"}";
  }
  json += "]}";
  return json;
}

size_t WriteCrashDumpToBuffer(char* buf, size_t bufSize) {
  if (!buf || bufSize == 0) {
    return 0;
  }
  buf[0] = '\0';
  size_t offset = 0;

  auto appendLine = [&](const char* line) {
    if (!line) {
      return;
    }
    const size_t lineLen = std::strlen(line);
    if (offset + lineLen + 2 >= bufSize) {
      return;
    }
    if (offset > 0) {
      buf[offset++] = '\n';
    }
    std::memcpy(buf + offset, line, lineLen);
    offset += lineLen;
    buf[offset] = '\0';
  };

  appendLine("=== SherpaNativeDiag crash activity dump ===");
  const DiagnosticSnapshot snap = GetSnapshot();
  char header[128];
  std::snprintf(
      header,
      sizeof(header),
      "enabled=%s signalHandlerInstalled=%s entryCount=%d",
      snap.enabled ? "true" : "false",
      snap.signalHandlerInstalled ? "true" : "false",
      snap.entryCount);
  appendLine(header);

  for (int i = 0; i < snap.entryCount; ++i) {
    const DiagnosticEntry& e = snap.entries[i];
    char line[256];
    if (e.detail[0] != '\0') {
      std::snprintf(
          line,
          sizeof(line),
          "[%llu] %s.%s %s (thread=%s tid=%u)",
          static_cast<unsigned long long>(e.seq),
          e.domain,
          e.phase,
          e.detail,
          e.threadName,
          e.tid);
    } else {
      std::snprintf(
          line,
          sizeof(line),
          "[%llu] %s.%s (thread=%s tid=%u)",
          static_cast<unsigned long long>(e.seq),
          e.domain,
          e.phase,
          e.threadName,
          e.tid);
    }
    appendLine(line);
  }
  appendLine("=== end SherpaNativeDiag ===");
  return offset;
}

} // namespace sherpa::diag

#if !defined(__ANDROID__) && !defined(__APPLE__)
namespace sherpa::diag {

void InstallPlatformSignalHandlers() {}

void DumpCrashLogFromBuffer(const char* /*buf*/, size_t /*len*/) {}

void LogRecordTrail(const char* /*domain*/, const char* /*phase*/, const char* /*detail*/) {}

void OnCrashSignal(int /*signo*/) {}

} // namespace sherpa::diag
#endif
