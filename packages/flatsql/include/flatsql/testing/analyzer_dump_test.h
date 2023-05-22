#pragma once

#include <filesystem>
#include <string>
#include <unordered_map>

#include "flatsql/proto/proto_generated.h"
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
    std::string schema;
    /// The script
    std::string script;
    /// The tables
    pugi::xml_document tables;
    /// The table references
    pugi::xml_document table_references;
    /// The column references
    pugi::xml_document column_references;
    /// The join edges
    pugi::xml_document join_edges;

    /// Encode a program
    static void EncodeProgram(pugi::xml_node root, const proto::ProgramT& program, std::string_view text);
    /// Get the grammar tests
    static void LoadTests(std::filesystem::path& project_root);
    /// Get the grammar tests
    static std::vector<const AnalyzerDumpTest*> GetTests(std::string_view filename);
};

}  // namespace flatsql::testing
