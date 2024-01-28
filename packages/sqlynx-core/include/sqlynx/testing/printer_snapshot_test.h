#pragma once

#include <filesystem>
#include <string>
#include <unordered_map>

#include "sqlynx/proto/proto_generated.h"
#include "gtest/gtest.h"
#include "pugixml.hpp"

namespace sqlynx::testing {

struct PrinterSnapshotTest {
    /// Printer test name
    struct TestPrinter {
        std::string operator()(const ::testing::TestParamInfo<const PrinterSnapshotTest*>& info) const {
            return std::string{info.param->name};
        }
    };

    /// The name
    std::string name;
    /// The input
    std::string input;
    /// The output
    std::string expected;

    /// Matches the expected output?
    ::testing::AssertionResult Matches(const pugi::xml_node& actual) const;

    /// Encode a program
    static void EncodeProgram(pugi::xml_node root, const proto::ParsedProgramT& program, std::string_view text);
    /// Get the grammar tests
    static void LoadTests(std::filesystem::path& project_root);
    /// Get the grammar tests
    static std::vector<const PrinterSnapshotTest*> GetTests(std::string_view filename);
};

}  // namespace sqlynx::testing
