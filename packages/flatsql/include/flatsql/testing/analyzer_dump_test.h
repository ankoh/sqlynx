#pragma once

#include <filesystem>
#include <string>
#include <unordered_map>

#include "flatsql/proto/proto_generated.h"
#include "flatsql/script.h"
#include "gtest/gtest.h"
#include "pugixml.hpp"

namespace flatsql::testing {

struct AnalyzerDumpTest {
    /// Printer test name
    struct TestPrinter {
        std::string operator()(const ::testing::TestParamInfo<const AnalyzerDumpTest*>& info) const {
            return std::string{info.param->name};
        }
    };

    /// The name
    std::string name;
    /// The schema
    std::string input_external;
    /// The script
    std::string input_main;
    /// The tables
    pugi::xml_document tables;
    /// The table references
    pugi::xml_document table_references;
    /// The column references
    pugi::xml_document column_references;
    /// The graph edges
    pugi::xml_document graph_edges;

    /// Encode a script
    static void EncodeScript(pugi::xml_node root, const AnalyzedScript& main, const AnalyzedScript* external);
    /// Get the grammar tests
    static void LoadTests(std::filesystem::path& project_root);
    /// Get the grammar tests
    static std::vector<const AnalyzerDumpTest*> GetTests(std::string_view filename);
};

}  // namespace flatsql::testing
