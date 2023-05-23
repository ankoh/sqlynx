#pragma once

#include "flatsql/analyzer/name_resolution_pass.h"
#include "flatsql/analyzer/pass_manager.h"
#include "flatsql/program.h"
#include "flatsql/utils/attribute_index.h"

namespace flatsql {

struct Analyzer {
    friend class AnalyzedProgram;

   protected:
    /// The scanned program
    ScannedProgram& scanned_program;
    /// The parsed program
    ParsedProgram& parsed_program;
    /// The attribute index
    AttributeIndex attribute_index;
    /// The pass manager
    PassManager pass_manager;
    /// The name resolution pass
    NameResolutionPass name_resolution;

   public:
    /// Constructor
    Analyzer(ScannedProgram& scanned, ParsedProgram& parsed);

    /// Analyze a program
    static std::unique_ptr<AnalyzedProgram> Analyze(ScannedProgram& scanned, ParsedProgram& parsed);
};

}  // namespace flatsql
