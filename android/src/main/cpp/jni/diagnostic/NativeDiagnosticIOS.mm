#include "NativeDiagnostic.h"

#if defined(__APPLE__)

#import <Foundation/Foundation.h>
#include <atomic>
#include <string>
#include <csignal>
#include <cstdio>
#include <cstring>
#include <unistd.h>
#include <os/log.h>

namespace sherpa::diag {

namespace {

constexpr size_t kCrashBufSize = 8192;
const char kSubsystem[] = "com.sherpaonnx.diag";
const char kCategory[] = "SherpaNativeDiag";

os_log_t DiagLog() {
  static os_log_t log = os_log_create(kSubsystem, kCategory);
  return log;
}

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
  const ssize_t written = write(STDERR_FILENO, buf, len);
  (void)written;
  if (len > 0 && buf[len - 1] != '\n') {
    static const char nl = '\n';
    write(STDERR_FILENO, &nl, 1);
  }
}

void LogRecordTrail(const char* domain, const char* phase, const char* detail) {
  if (!IsEnabled()) {
    return;
  }
  os_log_t log = DiagLog();
  if (detail && detail[0] != '\0') {
    os_log_info(log, "%{public}s.%{public}s %{public}s", domain ? domain : "?", phase ? phase : "?", detail);
  } else {
    os_log_info(log, "%{public}s.%{public}s", domain ? domain : "?", phase ? phase : "?");
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
  std::snprintf(header, sizeof(header), "SherpaNativeDiag: === signal %s ===\n", signame);
  size_t offset = 0;
  const size_t headerLen = std::strlen(header);
  if (headerLen < kCrashBufSize) {
    std::memcpy(crashBuf, header, headerLen);
    offset = headerLen;
  }

  offset += WriteCrashDumpToBuffer(crashBuf + offset, kCrashBufSize - offset);
  DumpCrashLogFromBuffer(crashBuf, offset);
}

__attribute__((constructor)) static void SherpaDiagAutoInit() { Init(true); }

} // namespace sherpa::diag

// C API for ObjC++ bridge
extern "C" {

const char* sherpa_diag_get_snapshot_json(void) {
  static thread_local std::string json;
  json = sherpa::diag::GetSnapshotJson();
  return json.c_str();
}

void sherpa_diag_set_enabled(int enabled) { sherpa::diag::SetEnabled(enabled != 0); }

void sherpa_diag_set_install_signal_handler(int install) {
  sherpa::diag::SetInstallSignalHandler(install != 0);
}

void sherpa_diag_init(int installSignalHandler) {
  sherpa::diag::Init(installSignalHandler != 0);
}

} // extern "C"

#endif // __APPLE__
