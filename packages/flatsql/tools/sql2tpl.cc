#include <filesystem>
#include <iostream>
#include <iostream>
#include <fstream>
#include <sstream>

#include "gflags/gflags.h"
#include "pugixml.hpp"

DEFINE_string(source_dir, "", "Source directory");
DEFINE_string(output_file, "", "Output file");

int main(int argc, char* argv[]) {
    gflags::SetUsageMessage("Usage: ./sql2tpl --source_dir <dir> --output_file <file>");
    gflags::ParseCommandLineFlags(&argc, &argv, false);

    // Check input directory argument
    if (!std::filesystem::exists(FLAGS_source_dir)) {
        std::cout << "Invalid source directory: " << FLAGS_source_dir << std::endl;
        return -1;
    }
    auto source_dir = std::filesystem::path{FLAGS_source_dir};

    // Check output file argument
    if (FLAGS_output_file == "") {
        std::cout << "Invalid output file" << std::endl;
        return -1;
    }
    std::ofstream out{FLAGS_output_file};


    // Create XML doc
    pugi::xml_document doc;
    auto xml_dumps = doc.append_child("parser-dumps");

    // Iterate over all file in the input directory
    for (auto& p : std::filesystem::directory_iterator(source_dir)) {
        // Skip all non-sql files
        auto filename = p.path().filename().filename().string();
        if (p.path().extension() != ".sql") continue;

        // Get test name
        auto path = p.path();
        auto dump_name = path.replace_extension().filename().string();

        // Read file stream
        std::ifstream in(p.path(), std::ios::in | std::ios::binary);
        if (!in) {
            std::cout << "[" << filename << "] failed to read file" << std::endl;
            continue;
        }
        std::stringstream inBuffer;
        inBuffer << in.rdbuf();
        auto dump_input = inBuffer.str();

        // Append an AST dump
        auto xml_dump = xml_dumps.append_child("parser-dump");
        xml_dump.append_attribute("name").set_value(dump_name.c_str());
        xml_dump.append_child("input").text().set(dump_input.c_str());
    }

    // Write the document to the file
    doc.save(out, "    ", pugi::format_default | pugi::format_no_declaration);
    return 0;
}
