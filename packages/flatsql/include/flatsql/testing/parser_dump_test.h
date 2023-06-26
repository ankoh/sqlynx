#pragma once

#include <filesystem>
#include <string>
#include <unordered_map>

#include "flatsql/proto/proto_generated.h"
#include "flatsql/script.h"
#include "gtest/gtest.h"
#include "pugixml.hpp"

namespace flatsql::testing {

/// Encode a location
void EncodeLocation(pugi::xml_node n, proto::Location loc, std::string_view text);
/// Encode an error
void EncodeError(pugi::xml_node n, const proto::ErrorT& err, std::string_view text);

struct ParserDumpTest {
    /// Printer test name
    struct TestPrinter {
        std::string operator()(const ::testing::TestParamInfo<const ParserDumpTest*>& info) const {
            return std::string{info.param->name};
        }
    };

    /// The name
    std::string name;
    /// The input
    std::string input;
    /// The expected output
    pugi::xml_document expected;

    /// Encode a script
    static void EncodeScript(pugi::xml_node root, const ScannedScript& scanned, const ParsedScript& parsed,
                             std::string_view text);
    /// Get the grammar tests
    static void LoadTests(std::filesystem::path& project_root);
    /// Get the grammar tests
    static std::vector<const ParserDumpTest*> GetTests(std::string_view filename);
};

}  // namespace flatsql::testing
