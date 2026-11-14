#pragma once

/**
 * Replaces the generated codegen header for the app's autolinking.cpp (which
 * includes <SherpaOnnxSpec.h>): same declarations, plus the hand-written
 * ReaderView insert descriptor so autolinking can register it.
 * The generated SherpaOnnxSpec-generated.cpp still includes its own header.
 */
#include <ReactCommon/JavaTurboModule.h>
#include <ReactCommon/TurboModule.h>
#include <jsi/jsi.h>

#include <react/renderer/components/SherpaOnnxSpec/SherpaReaderInsertComponentDescriptor.h>

namespace facebook::react {

JSI_EXPORT
std::shared_ptr<TurboModule> SherpaOnnxSpec_ModuleProvider(
    const std::string &moduleName,
    const JavaTurboModule::InitParams &params);

} // namespace facebook::react
