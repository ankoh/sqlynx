#pragma once

#include <span>

#include "dashql/buffers/index_generated.h"
#include "dashql/script.h"

namespace dashql {

struct PlannerInput {
    Script* script;
};

/// Plans relation-level hazards only. Opaque SELECT functions may have side effects;
/// barriers order statements but do not promise backend session affinity.
/// Entities retain native declaration identity; qualified-name lifetimes are internal.
struct Planner {
    /// Consumes current analysis without analyzing, publishing, or changing scripts.
    static buffers::execution::ExecutionGraphT Plan(std::span<const PlannerInput> inputs);
};

}  // namespace dashql
