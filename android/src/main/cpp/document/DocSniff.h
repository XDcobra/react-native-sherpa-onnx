#pragma once

#include "DocArchive.h"
#include "DocTypes.h"

namespace sherpa_onnx {
namespace document {

DocFormat SniffFormat(const DocumentSource& src, ArchiveReader* archive_or_null,
                      std::string* err_code, std::string* err_message);

}  // namespace document
}  // namespace sherpa_onnx
