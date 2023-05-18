#include <filesystem>
#include <string_view>

#include "flatsql/parser/parse_context.h"
#include "gflags/gflags.h"
#include "gtest/gtest.h"
#include "pugixml.hpp"

using namespace flatsql;

DEFINE_string(source_dir, "", "Source directory");

int main(int argc, char* argv[]) {
    gflags::SetUsageMessage("Usage: ./dump_printer --source_dir <dir>");
    gflags::ParseCommandLineFlags(&argc, &argv, false);

    if (!std::filesystem::exists(FLAGS_source_dir)) {
        std::cout << "Invalid source directory: " << FLAGS_source_dir << std::endl;
    }
    auto source_dir = std::filesystem::path{FLAGS_source_dir};
    (void)source_dir;
    return 0;
}
