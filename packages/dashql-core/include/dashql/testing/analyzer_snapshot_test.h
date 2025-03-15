#pragma once

#include <filesystem>
#include <string>

#include "gtest/gtest.h"
#include "pugixml.hpp"
#include "dashql/external.h"
#include "dashql/script.h"

namespace dashql::testing {

struct AnalyzerSnapshotTest {
    /// Printer test name
    struct TestPrinter {
        std::string operator()(const ::testing::TestParamInfo<const AnalyzerSnapshotTest*>& info) const {
            return std::string{info.param->name};
        }
    };
    /// A snapshot of a script analysis
    struct ScriptAnalysisSnapshot {
        /// The origin id
        CatalogEntryID external_id;
        /// The script
        std::string input;
        /// The errors
        pugi::xml_document errors;
        /// The tables
        pugi::xml_document tables;
        /// The table references
        pugi::xml_document table_references;
        /// The expressions
        pugi::xml_document expressions;
    };

    /// The name
    std::string name;
    /// The main script
    ScriptAnalysisSnapshot script;
    /// The catalog default database
    std::string catalog_default_database;
    /// The catalog default schema
    std::string catalog_default_schema;
    /// The entries
    std::vector<ScriptAnalysisSnapshot> catalog_entries;

    /// Read a registry
    static void TestRegistrySnapshot(const std::vector<ScriptAnalysisSnapshot>& snaps, pugi::xml_node& registry_node,
                                     Catalog& catalog, std::vector<std::unique_ptr<Script>>& catalog_scripts,
                                     size_t& entry_ids);
    /// Read a registry
    static void TestMainScriptSnapshot(const ScriptAnalysisSnapshot& snap, pugi::xml_node& node, Script& script,
                                       size_t entry_id);
    /// Encode a script
    static void EncodeScript(pugi::xml_node out, const AnalyzedScript& script, bool is_main);
    /// Get the grammar tests
    static void LoadTests(std::filesystem::path& project_root);
    /// Get the grammar tests
    static std::vector<const AnalyzerSnapshotTest*> GetTests(std::string_view filename);
};

extern void operator<<(std::ostream& out, const AnalyzerSnapshotTest& p);

}  // namespace dashql::testing
