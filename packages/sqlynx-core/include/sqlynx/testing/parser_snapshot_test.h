#pragma once

#include <filesystem>
#include <string>

#include "gtest/gtest.h"
#include "pugixml.hpp"
#include "sqlynx/script.h"

namespace sqlynx::testing {

struct ParserSnapshotTest {
    /// Printer test name
    struct TestPrinter {
        std::string operator()(const ::testing::TestParamInfo<const ParserSnapshotTest*>& info) const {
            return std::string{info.param->name};
        }
    };

    /// The name
    std::string name;
    /// The input
    std::string input;
    /// Debug the parser?
    bool debug = false;
    /// The expected output
    pugi::xml_document expected;

    /// Encode a script
    static void EncodeScript(pugi::xml_node root, const ScannedScript& scanned, const ParsedScript& parsed,
                             std::string_view text);
    /// Get the grammar tests
    static void LoadTests(std::filesystem::path& project_root);
    /// Get the grammar tests
    static std::vector<const ParserSnapshotTest*> GetTests(std::string_view filename);
};

extern void operator<<(std::ostream& out, const ParserSnapshotTest& p);

}  // namespace sqlynx::testing
