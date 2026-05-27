#include "NativeDiagnostic.h"

#if defined(__ANDROID__)

#include <android/log.h>
#include <csignal>
#include <cstdio>
#include <atomic>
#include <cstring>
#include <unistd.h>

namespace sherpa::diag {

namespace {

constexpr char kLogTag[] = "SherpaNativeDiag";
constexpr size_t kCrashBufSize = 8192;

struct SigActionSlot {
  int signo = 0;
  struct sigaction previous {};
  bool hasPrevious = false;
};

SigActionSlot g_slots[4];
int g_slotCount = 0;

void InvokePreviousHandler(const SigActionSlot& slot, int signo, siginfo_t* info, void* ucontext) {
  if (!slot.hasPrevious) {
    return;
  }
  const struct sigaction& prev = slot.previous;
  if ((prev.sa_flags & SA_SIGINFO) && prev.sa_sigaction) {
    prev.sa_sigaction(signo, info, ucontext);
    return;
  }
  if (prev.sa_handler == SIG_DFL) {
    signal(signo, SIG_DFL);
    raise(signo);
    return;
  }
  if (prev.sa_handler == SIG_IGN) {
    return;
  }
  if (prev.sa_handler) {
    prev.sa_handler(signo);
  }
}

void SherpaCrashHandler(int signo, siginfo_t* info, void* ucontext) {
  OnCrashSignal(signo);
  for (int i = 0; i < g_slotCount; ++i) {
    InvokePreviousHandler(g_slots[i], signo, info, ucontext);
  }
}

bool InstallOneSignal(int signo) {
  struct sigaction sa {};
  sa.sa_sigaction = SherpaCrashHandler;
  sigemptyset(&sa.sa_mask);
  sa.sa_flags = SA_SIGINFO | SA_ONSTACK;

  SigActionSlot slot;
  slot.signo = signo;
  if (sigaction(signo, &sa, &slot.previous) != 0) {
    return false;
  }
  slot.hasPrevious = true;
  if (g_slotCount < static_cast<int>(sizeof(g_slots) / sizeof(g_slots[0]))) {
    g_slots[g_slotCount++] = slot;
  }
  return true;
}

} // namespace

void DumpCrashLogFromBuffer(const char* buf, size_t len) {
  if (!buf || len == 0) {
    return;
  }
  size_t start = 0;
  for (size_t i = 0; i <= len; ++i) {
    if (i == len || buf[i] == '\n') {
      if (i > start) {
        char line[512];
        const size_t chunk =
            (i - start < sizeof(line) - 1) ? (i - start) : (sizeof(line) - 1);
        std::memcpy(line, buf + start, chunk);
        line[chunk] = '\0';
        __android_log_print(ANDROID_LOG_ERROR, kLogTag, "%s", line);
      }
      start = i + 1;
    }
  }
}

void LogRecordTrail(const char* domain, const char* phase, const char* detail) {
  if (!IsEnabled()) {
    return;
  }
  if (detail && detail[0] != '\0') {
    __android_log_print(
        ANDROID_LOG_INFO, kLogTag, "%s.%s %s", domain ? domain : "?", phase ? phase : "?", detail);
  } else {
    __android_log_print(
        ANDROID_LOG_INFO, kLogTag, "%s.%s", domain ? domain : "?", phase ? phase : "?");
  }
}

void InstallPlatformSignalHandlers() {
  if (!InstallSignalHandlerRequested() || IsSignalHandlerInstalled()) {
    return;
  }
  g_slotCount = 0;
  const bool ok = InstallOneSignal(SIGSEGV) && InstallOneSignal(SIGABRT) &&
                  InstallOneSignal(SIGBUS) && InstallOneSignal(SIGFPE);
  if (ok) {
    MarkSignalHandlerInstalled();
  }
}

void OnCrashSignal(int signo) {
  static std::atomic<bool> g_crashDumping{false};
  bool expected = false;
  if (!g_crashDumping.compare_exchange_strong(expected, true)) {
    return;
  }

  const char* signame = "UNKNOWN";
  switch (signo) {
    case SIGSEGV:
      signame = "SIGSEGV";
      break;
    case SIGABRT:
      signame = "SIGABRT";
      break;
    case SIGBUS:
      signame = "SIGBUS";
      break;
    case SIGFPE:
      signame = "SIGFPE";
      break;
    default:
      break;
  }

  static char crashBuf[kCrashBufSize];
  char header[128];
  std::snprintf(header, sizeof(header), "=== SherpaNativeDiag signal %s ===", signame);
  size_t offset = 0;
  const size_t headerLen = std::strlen(header);
  if (headerLen + 1 < kCrashBufSize) {
    std::memcpy(crashBuf, header, headerLen);
    offset = headerLen;
    crashBuf[offset++] = '\n';
    crashBuf[offset] = '\0';
  }

  offset += WriteCrashDumpToBuffer(crashBuf + offset, kCrashBufSize - offset);
  DumpCrashLogFromBuffer(crashBuf, offset);
}

__attribute__((constructor)) static void SherpaDiagAutoInit() { Init(true); }

} // namespace sherpa::diag

#endif // __ANDROID__
