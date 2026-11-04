#pragma once

#include "SegTypes.h"

#include <string>
#include <vector>

/** Spool / snapshot envelope: {"segments":[...]} — portable, no ObjC. */
std::string segment_records_to_json(const std::vector<SegRecord> &segments);
std::vector<SegRecord> segment_records_from_json(const std::string &json);
