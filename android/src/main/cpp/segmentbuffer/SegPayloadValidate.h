#pragma once

/**
 * Shared speech-segment payload schema (ported from iOS ObjC strict validator).
 * Authoritative native gate for live speech append.
 */

#include <string>

/** Validate speech payload JSON object. Empty / non-object / schema errors → false. */
bool seg_validate_speech_payload_json(const std::string &payloadJson, std::string *error = nullptr);
