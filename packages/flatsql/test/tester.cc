#include <string_view>

#include "flatsql/parser/parse_context.h"
#include "flatsql/testing/parser_dump_test.h"
#include "gflags/gflags.h"
#include "gtest/gtest.h"
#include "pugixml.hpp"

using namespace flatsql;
using namespace flatsql::testing;

DEFINE_string(source_dir, "", "Source directory");

int main(int argc, char* argv[]) {
    gflags::AllowCommandLineReparsing();
    gflags::SetUsageMessage("Usage: ./tester --source_dir <dir>");
    gflags::ParseCommandLineFlags(&argc, &argv, false);

    if (!std::filesystem::exists(FLAGS_source_dir)) {
        std::cout << "Invalid source directory: " << FLAGS_source_dir << std::endl;
    }
    auto source_dir = std::filesystem::path{FLAGS_source_dir};
    ParserDumpTest::LoadTests(source_dir);

    ::testing::InitGoogleTest(&argc, argv);
    return RUN_ALL_TESTS();
}
