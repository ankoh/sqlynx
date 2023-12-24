#pragma once

#include <filesystem>
#include <string>
#include <unordered_map>

#include "gtest/gtest.h"
#include "pugixml.hpp"
#include "sqlynx/origin.h"
#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/script.h"

namespace sqlynx::testing {

struct AnalyzerSnapshotTest {
    /// Printer test name
    struct TestPrinter {
        std::string operator()(const ::testing::TestParamInfo<const AnalyzerSnapshotTest*>& info) const {
            return std::string{info.param->name};
        }
    };
    /// A script
    struct TestScript {
        /// The origin id
        OriginID origin_id;
        /// The script
        std::string input;
        /// The tables
        pugi::xml_document tables;
        /// The table references
        pugi::xml_document table_references;
        /// The column references
        pugi::xml_document column_references;
        /// The graph edges
        pugi::xml_document graph_edges;
    };

    /// The name
    std::string name;
    /// The main script
    TestScript script;
    /// The entries
    std::vector<TestScript> registry;

    /// Encode a script
    static void EncodeScript(pugi::xml_node out, const AnalyzedScript& script, bool is_main);
    /// Get the grammar tests
    static void LoadTests(std::filesystem::path& project_root);
    /// Get the grammar tests
    static std::vector<const AnalyzerSnapshotTest*> GetTests(std::string_view filename);
};

extern void operator<<(std::ostream& out, const AnalyzerSnapshotTest& p);

}  // namespace sqlynx::testing
