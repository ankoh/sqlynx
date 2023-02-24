#include <string_view>

#include "flatsql/parser/parser_driver.h"
#include "flatsql/testing/astdump_test.h"
#include "gflags/gflags.h"
#include "gtest/gtest.h"
#include "pugixml.hpp"

using namespace flatsql;
using namespace flatsql::testing;

DEFINE_string(source_dir, "", "Source directory");

namespace flatsql::testing {
std::filesystem::path SOURCE_DIR;
}

int main(int argc, char* argv[]) {
    gflags::AllowCommandLineReparsing();
    gflags::SetUsageMessage("Usage: ./tester --source_dir <dir>");
    gflags::ParseCommandLineFlags(&argc, &argv, false);

    if (!std::filesystem::exists(FLAGS_source_dir)) {
        std::cout << "Invalid source directory: " << FLAGS_source_dir << std::endl;
    }
    SOURCE_DIR = std::filesystem::path{FLAGS_source_dir};
    ASTDumpTest::LoadTests(SOURCE_DIR);

    ::testing::InitGoogleTest(&argc, argv);
    return RUN_ALL_TESTS();
}
