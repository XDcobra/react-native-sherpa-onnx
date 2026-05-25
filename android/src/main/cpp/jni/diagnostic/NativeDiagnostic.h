#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

namespace sherpa::diag {

constexpr int kRingCapacity = 64;
constexpr size_t kThreadNameMax = 16;
constexpr size_t kDomainMax = 24;
constexpr size_t kPhaseMax = 32;
constexpr size_t kDetailMax = 48;

struct DiagnosticEntry {
  uint64_t seq = 0;
  uint64_t monotonicMs = 0;
  uint32_t tid = 0;
  char threadName[kThreadNameMax];
  char domain[kDomainMax];
  char phase[kPhaseMax];
  char detail[kDetailMax];
};

struct DiagnosticSnapshot {
  bool enabled = true;
  bool signalHandlerInstalled = false;
  DiagnosticEntry entries[kRingCapacity];
  int entryCount = 0;
};

/** Idempotent. Called from library constructor (installSignalHandler default true). */
void Init(bool installSignalHandler = true);

void SetEnabled(bool enabled);
bool IsEnabled();

void SetInstallSignalHandler(bool install);
bool IsSignalHandlerInstalled();
bool InstallSignalHandlerRequested();

/** Records one activity entry (no-op when disabled). */
void Record(const char* domain, const char* phase, const char* detail = nullptr);

DiagnosticSnapshot GetSnapshot();

/** JSON for JNI / ObjC bridge. */
std::string GetSnapshotJson();

/**
 * Writes a human-readable crash dump into buf (newline-separated lines).
 * Signal-handler safe: no heap allocation. Returns bytes written (excl. NUL).
 */
size_t WriteCrashDumpToBuffer(char* buf, size_t bufSize);

/** Platform-specific crash log + handler install (Android / iOS). */
void InstallPlatformSignalHandlers();
void DumpCrashLogFromBuffer(const char* buf, size_t len);
void LogRecordTrail(const char* domain, const char* phase, const char* detail);
void MarkSignalHandlerInstalled();
void OnCrashSignal(int signo);

const char* SanitizeDetail(const char* detail, char* scratch, size_t scratchSize);

} // namespace sherpa::diag

#define SHERPA_DIAG(domain, phase) ::sherpa::diag::Record(domain, phase, nullptr)
#define SHERPA_DIAG_D(domain, phase, detail) ::sherpa::diag::Record(domain, phase, detail)
