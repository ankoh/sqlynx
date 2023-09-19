#include "flatsql/analyzer/completion.h"
#include "flatsql/parser/parse_context.h"
#include "flatsql/parser/scanner.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/script.h"
#include "flatsql/testing/completion_dump_test.h"
#include "flatsql/testing/xml_tests.h"
#include "gtest/gtest.h"
#include "pugixml.hpp"

using namespace flatsql;
using namespace flatsql::testing;

namespace {

struct CompletionDumpTestSuite : public ::testing::TestWithParam<const CompletionDumpTest*> {};

TEST_P(CompletionDumpTestSuite, Test) {
    auto* test = GetParam();

    // XXX
}

// clang-format off
INSTANTIATE_TEST_SUITE_P(Basic, CompletionDumpTestSuite, ::testing::ValuesIn(CompletionDumpTest::GetTests("basic.xml")), CompletionDumpTest::TestPrinter());

}
