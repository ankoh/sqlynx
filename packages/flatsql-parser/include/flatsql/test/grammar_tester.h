#ifndef INCLUDE_FLATSQL_TEST_GRAMMAR_TESTS_H_
#define INCLUDE_FLATSQL_TEST_GRAMMAR_TESTS_H_

#include <filesystem>
#include <string>
#include <unordered_map>

#include "flatsql/proto/proto_generated.h"
#include "gtest/gtest.h"
#include "pugixml.hpp"

namespace flatsql::test {

/// Encode a location
void EncodeLocation(pugi::xml_node n, proto::Location loc, std::string_view text);
/// Encode an error
void EncodeError(pugi::xml_node n, const proto::ErrorT& err, std::string_view text);

struct GrammarTest {
    /// Printer test name
    struct TestPrinter {
        std::string operator()(const ::testing::TestParamInfo<const GrammarTest*>& info) const {
            return std::string{info.param->name};
        }
    };

    /// The name
    std::string name;
    /// The input
    std::string input;
    /// The expected output
    pugi::xml_document expected;

    /// Matches the expected output?
    ::testing::AssertionResult Matches(const pugi::xml_node& actual) const;

    /// Encode a program
    static void EncodeProgram(pugi::xml_node root, const proto::ProgramT& program, std::string_view text);
    /// Get the grammar tests
    static void LoadTests(std::filesystem::path& project_root);
    /// Get the grammar tests
    static std::vector<const GrammarTest*> GetTests(std::string_view filename);
};

}  // namespace flatsql::test

#endif  // INCLUDE_FLATSQL_TEST_GRAMMAR_TESTS_H_
