/**
 * SherpaOnnx+StreamingPipelineControl.mm
 *
 * Generic streaming pipeline control methods (stop, flush, reset, getStatus).
 * These work with any StreamingPipelineWorker registered in the global registry,
 * regardless of the specific pipeline type (enhancement, STT, TTS, etc.).
 */

#import "../../SherpaOnnx.h"
#import <React/RCTLog.h>
#include "../core/SherpaOnnx+StreamingPipeline.h"
#include <string>

@implementation SherpaOnnx (StreamingPipelineControl)

- (void)stopStreamingPipeline:(NSString *)pipelineId
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject
{
    std::string pid = [pipelineId UTF8String];
    std::shared_ptr<StreamingPipelineWorker> worker;
    {
        std::lock_guard<std::mutex> lock(g_streaming_pipeline_mutex);
        auto it = g_streaming_pipelines.find(pid);
        if (it == g_streaming_pipelines.end()) {
            reject(@"PIPELINE_NOT_FOUND",
                   [NSString stringWithFormat:@"Streaming pipeline '%@' not found", pipelineId], nil);
            return;
        }
        worker = it->second;
        g_streaming_pipelines.erase(it);
    }
    worker->stop();
    resolve(nil);
}

- (void)flushStreamingPipeline:(NSString *)pipelineId
                       resolve:(RCTPromiseResolveBlock)resolve
                        reject:(RCTPromiseRejectBlock)reject
{
    std::shared_ptr<StreamingPipelineWorker> worker;
    {
        std::lock_guard<std::mutex> lock(g_streaming_pipeline_mutex);
        auto it = g_streaming_pipelines.find(std::string([pipelineId UTF8String]));
        if (it == g_streaming_pipelines.end()) {
            reject(@"PIPELINE_NOT_FOUND",
                   [NSString stringWithFormat:@"Streaming pipeline '%@' not found", pipelineId], nil);
            return;
        }
        worker = it->second;
    }

    try {
        auto future = worker->flush();
        future.get(); // Block until flush completes
        resolve(nil);
    } catch (const std::exception &e) {
        reject(@"PIPELINE_FLUSH_ERROR",
               [NSString stringWithUTF8String:e.what()], nil);
    }
}

- (void)resetStreamingPipeline:(NSString *)pipelineId
                       resolve:(RCTPromiseResolveBlock)resolve
                        reject:(RCTPromiseRejectBlock)reject
{
    std::shared_ptr<StreamingPipelineWorker> worker;
    {
        std::lock_guard<std::mutex> lock(g_streaming_pipeline_mutex);
        auto it = g_streaming_pipelines.find(std::string([pipelineId UTF8String]));
        if (it == g_streaming_pipelines.end()) {
            reject(@"PIPELINE_NOT_FOUND",
                   [NSString stringWithFormat:@"Streaming pipeline '%@' not found", pipelineId], nil);
            return;
        }
        worker = it->second;
    }

    try {
        auto future = worker->reset();
        future.get(); // Block until reset completes
        resolve(nil);
    } catch (const std::exception &e) {
        reject(@"PIPELINE_RESET_ERROR",
               [NSString stringWithUTF8String:e.what()], nil);
    }
}

- (void)getStreamingPipelineStatus:(NSString *)pipelineId
                           resolve:(RCTPromiseResolveBlock)resolve
                            reject:(RCTPromiseRejectBlock)reject
{
    std::shared_ptr<StreamingPipelineWorker> worker;
    {
        std::lock_guard<std::mutex> lock(g_streaming_pipeline_mutex);
        auto it = g_streaming_pipelines.find(std::string([pipelineId UTF8String]));
        if (it == g_streaming_pipelines.end()) {
            reject(@"PIPELINE_NOT_FOUND",
                   [NSString stringWithFormat:@"Streaming pipeline '%@' not found", pipelineId], nil);
            return;
        }
        worker = it->second;
    }

    auto status = worker->getStatus();
    resolve(@{
        @"pipelineId": pipelineId,
        @"isRunning": @(status.isRunning),
        @"chunksProcessed": @((double)status.chunksProcessed),
        @"unitsRead": @((double)status.unitsRead),
        @"unitsWritten": @((double)status.unitsWritten),
        @"error": status.error.empty() ? [NSNull null] : [NSString stringWithUTF8String:status.error.c_str()],
    });
}

@end
