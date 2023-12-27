#pragma once

#include <filesystem>
#include <string>
#include <unordered_map>

#include "gtest/gtest.h"
#include "pugixml.hpp"
#include "sqlynx/external.h"
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
    struct AnalysisSnapshot {
        /// The origin id
        ExternalID external_id;
        /// The database name
        std::string database_name;
        /// The schema name
        std::string schema_name;
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
    AnalysisSnapshot script;
    /// The entries
    std::vector<AnalysisSnapshot> registry;

    /// Read a registry
    static void TestRegistrySnapshot(const std::vector<AnalysisSnapshot>& snaps, pugi::xml_node& registry_node,
                                     SchemaRegistry& registry, std::vector<std::unique_ptr<Script>>& scripts,
                                     size_t& entry_ids);
    /// Read a registry
    static void TestMainScriptSnapshot(const AnalysisSnapshot& snap, const SchemaRegistry& registry,
                                       pugi::xml_node& node, Script& script, size_t entry_id);
    /// Encode a script
    static void EncodeScript(pugi::xml_node out, const AnalyzedScript& script, bool is_main);
    /// Get the grammar tests
    static void LoadTests(std::filesystem::path& project_root);
    /// Get the grammar tests
    static std::vector<const AnalyzerSnapshotTest*> GetTests(std::string_view filename);
};

extern void operator<<(std::ostream& out, const AnalyzerSnapshotTest& p);

}  // namespace sqlynx::testing
