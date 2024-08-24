#pragma once

#include "sqlynx/analyzer/pass_manager.h"
#include "sqlynx/catalog.h"
#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/utils/attribute_index.h"

namespace sqlynx {

struct NameResolutionPass;
class AnalyzedScript;

struct Analyzer {
    friend class AnalyzedScript;

   protected:
    /// The catalog
    Catalog& catalog;
    /// The parsed program
    const std::shared_ptr<ParsedScript> parsed;
    /// The parsed program
    std::shared_ptr<AnalyzedScript> analyzed;
    /// The attribute index
    AttributeIndex attribute_index;
    /// The pass manager
    PassManager pass_manager;
    /// The name resolution pass
    std::unique_ptr<NameResolutionPass> name_resolution;

   public:
    /// Constructor
    Analyzer(std::shared_ptr<ParsedScript> parsed, Catalog& catalog);

    /// Analyze a program
    static std::pair<std::shared_ptr<AnalyzedScript>, proto::StatusCode> Analyze(std::shared_ptr<ParsedScript> parsed,
                                                                                 Catalog& catalog);
};

}  // namespace sqlynx
