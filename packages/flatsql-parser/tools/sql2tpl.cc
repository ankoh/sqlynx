#include <filesystem>
#include <iostream>

#include "gflags/gflags.h"

DEFINE_string(source_dir, "", "Source directory");
DEFINE_string(output_file, "", "Output file");

int main(int argc, char* argv[]) {
    gflags::SetUsageMessage("Usage: ./sql2tpl --source_dir <dir> --output_file <file>");
    gflags::ParseCommandLineFlags(&argc, &argv, false);

    if (!std::filesystem::exists(FLAGS_source_dir)) {
        std::cout << "Invalid source directory: " << FLAGS_source_dir << std::endl;
    }
    auto source_dir = std::filesystem::path{FLAGS_source_dir};



    return 0;
}
