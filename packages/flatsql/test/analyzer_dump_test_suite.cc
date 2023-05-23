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
    auto schema = rope::Rope::FromString(1024, test->schema);
    auto script = rope::Rope::FromString(1024, test->script);

    // Analyze schema
    auto schema_scan = parser::Scanner::Scan(schema);
    auto schema_parsed = parser::ParseContext::Parse(*schema_scan);
    auto schema_analyzed = Analyzer::Analyze(*schema_scan, *schema_parsed);

    // Analyze script
    auto script_scan = parser::Scanner::Scan(script);
    auto script_parsed = parser::ParseContext::Parse(*script_scan);
    auto script_analyzed = Analyzer::Analyze(*script_scan, *script_parsed, schema_analyzed.get());
}

// clang-format off
INSTANTIATE_TEST_SUITE_P(Setup, AnalyzerDumpTestSuite, ::testing::ValuesIn(AnalyzerDumpTest::GetTests("setup.xml")), AnalyzerDumpTest::TestPrinter());
