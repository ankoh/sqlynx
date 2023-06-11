#include "flatsql/analyzer/analyzer.h"
#include "flatsql/parser/parse_context.h"
#include "flatsql/parser/scanner.h"
#include "flatsql/program.h"
#include "flatsql/testing/analyzer_dump_test.h"
#include "gtest/gtest.h"
#include "pugixml.hpp"

using namespace flatsql;
using namespace flatsql::testing;

struct AnalyzerDumpTestSuite : public ::testing::TestWithParam<const AnalyzerDumpTest*> {};

TEST_P(AnalyzerDumpTestSuite, Test) {
    auto* test = GetParam();
    auto input_external = rope::Rope::FromString(1024, test->input_external);
    auto input_main = rope::Rope::FromString(1024, test->input_main);

    // Analyze schema
    auto external_scan = parser::Scanner::Scan(input_external);
    auto external_parsed = parser::ParseContext::Parse(*external_scan);
    auto external_analyzed = Analyzer::Analyze(*external_scan, *external_parsed);

    // Analyze script
    auto main_scan = parser::Scanner::Scan(input_main);
    auto main_parsed = parser::ParseContext::Parse(*main_scan);
    auto main_analyzed = Analyzer::Analyze(*main_scan, *main_parsed, external_analyzed.get());
}

// clang-format off
INSTANTIATE_TEST_SUITE_P(Setup, AnalyzerDumpTestSuite, ::testing::ValuesIn(AnalyzerDumpTest::GetTests("basic.xml")), AnalyzerDumpTest::TestPrinter());
