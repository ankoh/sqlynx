#include <string_view>

#include "sqlynx/parser/parser.h"
#include "sqlynx/testing/analyzer_snapshot_test.h"
#include "sqlynx/testing/completion_snapshot_test.h"
#include "sqlynx/testing/parser_snapshot_test.h"
#include "gflags/gflags.h"
#include "gtest/gtest.h"
#include "pugixml.hpp"

using namespace sqlynx;
using namespace sqlynx::testing;

std::filesystem::path source_dir;
bool update_expecteds;

DEFINE_bool(update_expecteds, false, "Update the test expectations");
DEFINE_string(source_dir, "", "Source directory");

int main(int argc, char* argv[]) {
    gflags::AllowCommandLineReparsing();
    gflags::SetUsageMessage("Usage: ./tester --source_dir <dir>");
    gflags::ParseCommandLineFlags(&argc, &argv, false);

    if (!std::filesystem::exists(FLAGS_source_dir)) {
        std::cout << "Invalid source directory: " << FLAGS_source_dir << std::endl;
    }
    source_dir = std::filesystem::path{FLAGS_source_dir};
    update_expecteds = FLAGS_update_expecteds;
    ParserSnapshotTest::LoadTests(source_dir);
    AnalyzerSnapshotTest::LoadTests(source_dir);
    CompletionSnapshotTest::LoadTests(source_dir);

    ::testing::InitGoogleTest(&argc, argv);
    return RUN_ALL_TESTS();
}
