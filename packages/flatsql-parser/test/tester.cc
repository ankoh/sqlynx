#include <string_view>

#include "flatsql/parser/parser_driver.h"
#include "flatsql/test/grammar_tester.h"
#include "gflags/gflags.h"
#include "gtest/gtest.h"
#include "pugixml.hpp"

using namespace flatsql;
using namespace flatsql::test;

DEFINE_string(source_dir, "", "Source directory");

namespace flatsql::test {
std::filesystem::path SOURCE_DIR;
}

int main(int argc, char* argv[]) {
    gflags::AllowCommandLineReparsing();
    gflags::SetUsageMessage("Usage: ./tester --source_dir <dir>");
    gflags::ParseCommandLineFlags(&argc, &argv, false);

    if (!std::filesystem::exists(FLAGS_source_dir)) {
        std::cout << "Directory does not exist: " << FLAGS_source_dir << std::endl;
    }
    SOURCE_DIR = std::filesystem::path{FLAGS_source_dir};
    GrammarTest::LoadTests(SOURCE_DIR);

    testing::InitGoogleTest(&argc, argv);
    return RUN_ALL_TESTS();
}
