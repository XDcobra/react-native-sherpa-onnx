#include "PunctuationOfflineLivePipelineWorker.h"

#include <stdexcept>

extern "C" bool sherpaonnx_punct_offline_add_punctuation_if_exists(
    const std::string &instanceId,
    const std::string &text,
    std::string *outText);

PunctuationOfflineLivePipelineWorker::PunctuationOfflineLivePipelineWorker(
  std::string pipelineId,
  std::string attachedSegmentationEngineId,
  std::shared_ptr<TxtLiveEntry> textInput,
  std::string textSegmentInputBufferId,
  std::shared_ptr<TxtLiveEntry> textOutput,
  std::string punctuationInstanceId
)
  : OfflineLivePipelineWorker(
      std::move(pipelineId),
      std::move(attachedSegmentationEngineId),
      nullptr,
      std::move(textSegmentInputBufferId),
      textInput
    ),
    textOutput_(std::move(textOutput)),
    punctuationInstanceId_(std::move(punctuationInstanceId))
{}

void PunctuationOfflineLivePipelineWorker::onSegmentCommitted(
  const CommittedSegmentRef &segment
) {
  if (!std::holds_alternative<CommittedSegmentText>(segment)) return;
  if (!textOutput_) {
    throw std::runtime_error("Invalid punctuation live pipeline worker state");
  }

  const auto &textSeg = std::get<CommittedSegmentText>(segment);
  if (textSeg.text.empty()) return;

  std::string punctuated;
  if (!sherpaonnx_punct_offline_add_punctuation_if_exists(
        punctuationInstanceId_,
        textSeg.text,
        &punctuated
      )) {
    throw std::runtime_error("Offline punctuation instance not found during live pipeline processing");
  }

  NSMutableDictionary *meta = [NSMutableDictionary dictionaryWithDictionary:@{
    @"__segmentReason": @"punctuation",
  }];
  if (textSeg.meta != nil) {
    [meta addEntriesFromDictionary:textSeg.meta];
  }

  std::string err;
  if (!txt_live_commit_segment(
        textOutput_,
        punctuated,
        {},
        {},
        "segmentation_engine",
        meta,
        &err
      )) {
    throw std::runtime_error(
      err.empty() ? "Failed to commit punctuation text segment" : err
    );
  }

  addUnitsWritten(static_cast<int64_t>(punctuated.size()));
}
