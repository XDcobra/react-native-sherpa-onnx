#include "PdfDocument.h"
#include "PdfLog.h"

#include <cerrno>
#include <cstddef>
#include <mutex>
#include <utility>

#if defined(HAVE_PDFIUM) && HAVE_PDFIUM
#include <sys/stat.h>
#include <unistd.h>
#endif

namespace sherpa_onnx {
namespace pdf {

struct PdfDocument::FileAccess {
#if defined(HAVE_PDFIUM) && HAVE_PDFIUM
  int fd = -1;
  FPDF_FILEACCESS access{};
  ~FileAccess() {
    if (fd >= 0) {
      ::close(fd);
      fd = -1;
    }
  }
  static int GetBlock(
      void* param,
      unsigned long position,
      unsigned char* pBuf,
      unsigned long size);
#endif
};

#if defined(HAVE_PDFIUM) && HAVE_PDFIUM

namespace {

std::once_flag g_pdfium_once;

void EnsurePdfiumInit() {
  std::call_once(g_pdfium_once, []() { FPDF_InitLibrary(); });
}

void SetOpenError(
    unsigned long err,
    std::string* err_code,
    std::string* err_message) {
  if (err == FPDF_ERR_PASSWORD) {
    if (err_code) *err_code = kErrEncrypted;
    if (err_message) {
      *err_message = "PDF is encrypted or password-protected";
    }
    return;
  }
  if (err_code) *err_code = kErrOpenFailed;
  if (err_message) *err_message = "Failed to open PDF document";
}

}  // namespace

int PdfDocument::FileAccess::GetBlock(
    void* param,
    unsigned long position,
    unsigned char* pBuf,
    unsigned long size) {
  auto* self = static_cast<FileAccess*>(param);
  if (!self || self->fd < 0 || !pBuf || size == 0) {
    return 0;
  }
  size_t got = 0;
  while (got < static_cast<size_t>(size)) {
    const ssize_t n = ::pread(
        self->fd,
        pBuf + got,
        static_cast<size_t>(size) - got,
        static_cast<off_t>(static_cast<unsigned long long>(position) + got));
    if (n < 0) {
      if (errno == EINTR) continue;
      return 0;
    }
    if (n == 0) {
      return 0;
    }
    got += static_cast<size_t>(n);
  }
  return 1;
}

PdfDocument::PdfDocument(
    FPDF_DOCUMENT doc,
    std::unique_ptr<FileAccess> file_access)
    : doc_(doc), file_access_(std::move(file_access)) {}

PdfDocument::PdfDocument(PdfDocument&& other) noexcept
    : doc_(other.doc_), file_access_(std::move(other.file_access_)) {
  other.doc_ = nullptr;
}

PdfDocument& PdfDocument::operator=(PdfDocument&& other) noexcept {
  if (this != &other) {
    if (doc_) {
      FPDF_CloseDocument(doc_);
      doc_ = nullptr;
    }
    file_access_.reset();
    doc_ = other.doc_;
    other.doc_ = nullptr;
    file_access_ = std::move(other.file_access_);
  }
  return *this;
}

PdfDocument::~PdfDocument() {
  if (doc_) {
    FPDF_CloseDocument(doc_);
    doc_ = nullptr;
  }
  file_access_.reset();
}

bool PdfDocument::ok() const { return doc_ != nullptr; }

int PdfDocument::page_count() const {
  return doc_ ? FPDF_GetPageCount(doc_) : 0;
}

PdfDocument PdfDocument::OpenPath(
    const char* path,
    std::string* err_code,
    std::string* err_message) {
  if (!path || path[0] == '\0') {
    if (err_code) *err_code = kErrInvalidArgument;
    if (err_message) *err_message = "PDF path required";
    return PdfDocument();
  }
  EnsurePdfiumInit();
  PDF_LOGI("OpenPath path=%s", path);
  FPDF_DOCUMENT doc = FPDF_LoadDocument(path, nullptr);
  if (!doc) {
    SetOpenError(FPDF_GetLastError(), err_code, err_message);
    PDF_LOGW("OpenPath failed path=%s", path);
    return PdfDocument();
  }
  return PdfDocument(doc, nullptr);
}

PdfDocument PdfDocument::OpenFd(
    int fd,
    std::string* err_code,
    std::string* err_message) {
  if (fd < 0) {
    if (err_code) *err_code = kErrInvalidArgument;
    if (err_message) *err_message = "PDF fd required";
    return PdfDocument();
  }
  const int dupfd = ::dup(fd);
  if (dupfd < 0) {
    if (err_code) *err_code = kErrOpenFailed;
    if (err_message) *err_message = "Failed to dup PDF file descriptor";
    PDF_LOGW("OpenFd dup failed fd=%d errno=%d", fd, errno);
    return PdfDocument();
  }
  struct stat st {};
  if (::fstat(dupfd, &st) != 0 || st.st_size <= 0) {
    ::close(dupfd);
    if (err_code) *err_code = kErrOpenFailed;
    if (err_message) {
      *err_message = "PDF file descriptor has no seekable length";
    }
    PDF_LOGW("OpenFd fstat failed fd=%d", fd);
    return PdfDocument();
  }

  auto access = std::make_unique<FileAccess>();
  access->fd = dupfd;
  access->access.m_FileLen = static_cast<unsigned long>(st.st_size);
  access->access.m_GetBlock = &FileAccess::GetBlock;
  access->access.m_Param = access.get();

  EnsurePdfiumInit();
  PDF_LOGI(
      "OpenFd fd=%d dup=%d len=%lld", fd, dupfd,
      static_cast<long long>(st.st_size));
  FPDF_DOCUMENT doc = FPDF_LoadCustomDocument(&access->access, nullptr);
  if (!doc) {
    SetOpenError(FPDF_GetLastError(), err_code, err_message);
    PDF_LOGW("OpenFd LoadCustomDocument failed fd=%d", fd);
    return PdfDocument();
  }
  return PdfDocument(doc, std::move(access));
}

PdfDocument PdfDocument::Open(
    const PdfSource& src,
    std::string* err_code,
    std::string* err_message) {
  if (!src.path.empty()) {
    return OpenPath(src.path.c_str(), err_code, err_message);
  }
  if (src.fd >= 0) {
    return OpenFd(src.fd, err_code, err_message);
  }
  if (err_code) *err_code = kErrInvalidArgument;
  if (err_message) {
    *err_message = "PDF source requires a filesystem path or file descriptor";
  }
  PDF_LOGW("Open missing path and fd");
  return PdfDocument();
}

#else  // !HAVE_PDFIUM

PdfDocument::PdfDocument(PdfDocument&&) noexcept = default;
PdfDocument& PdfDocument::operator=(PdfDocument&&) noexcept = default;
PdfDocument::~PdfDocument() = default;

bool PdfDocument::ok() const { return false; }

int PdfDocument::page_count() const { return 0; }

namespace {

PdfDocument Disabled(std::string* err_code, std::string* err_message) {
  if (err_code) *err_code = kErrDisabled;
  if (err_message) {
    *err_message =
        "PDFium is not linked. Rebuild with sherpaOnnxEnablePdfium=true "
        "(Android) or SHERPA_ONNX_ENABLE_PDFIUM=1 (iOS) and ensure pdfium "
        "prebuilts resolve.";
  }
  return PdfDocument();
}

}  // namespace

PdfDocument PdfDocument::OpenPath(
    const char*,
    std::string* err_code,
    std::string* err_message) {
  return Disabled(err_code, err_message);
}

PdfDocument PdfDocument::OpenFd(
    int,
    std::string* err_code,
    std::string* err_message) {
  return Disabled(err_code, err_message);
}

PdfDocument PdfDocument::Open(
    const PdfSource&,
    std::string* err_code,
    std::string* err_message) {
  return Disabled(err_code, err_message);
}

#endif

}  // namespace pdf
}  // namespace sherpa_onnx
