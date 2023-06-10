#include <filesystem>
#include <fstream>
#include <string_view>

#include "flatsql/analyzer/analyzer.h"
#include "flatsql/parser/parse_context.h"
#include "flatsql/parser/scanner.h"
#include "flatsql/testing/analyzer_dump_test.h"
#include "gflags/gflags.h"
#include "gtest/gtest.h"
#include "pugixml.hpp"

using namespace flatsql;
using namespace flatsql::testing;

DEFINE_string(source_dir, "", "Source directory");

static void generate_analyzer_dumps(const std::filesystem::path& source_dir) {
    auto dump_dir = source_dir / "dumps" / "analyzer";
    for (auto& p : std::filesystem::directory_iterator(dump_dir)) {
        auto filename = p.path().filename().filename().string();

        // Is template file file
        auto out = p.path();
        if (out.extension() != ".xml") continue;
        out.replace_extension();
        if (out.extension() != ".tpl") continue;
        out.replace_extension(".xml");

        // Open input stream
        std::ifstream in(p.path(), std::ios::in | std::ios::binary);
        if (!in) {
            std::cout << "[" << filename << "] failed to read file" << std::endl;
            continue;
        }

        // Open output stream
        std::cout << "FILE " << out << std::endl;
        std::ofstream outs;
        outs.open(out, std::ofstream::out | std::ofstream::trunc);

        // Parse xml document
        pugi::xml_document doc;
        doc.load(in);
        auto root = doc.child("analyzer-dumps");

        for (auto test : root.children()) {
            // Copy expected
            auto name = test.attribute("name").as_string();
            std::cout << "  TEST " << name << std::endl;

            // Read the schema
            std::string schema_text = test.child("schema").last_child().value();
            auto schema_rope = rope::Rope::FromString(1024, schema_text);
            auto schema_scan = parser::Scanner::Scan(schema_rope);
            auto schema_parsed = parser::ParseContext::Parse(*schema_scan);
            auto schema_analyzed = Analyzer::Analyze(*schema_scan, *schema_parsed);

            /// Read the script
            std::string script_text = test.child("script").last_child().value();
            auto script_rope = rope::Rope::FromString(1024, script_text);
            auto script_scan = parser::Scanner::Scan(script_rope);
            auto script_parsed = parser::ParseContext::Parse(*script_scan);
            auto script_analyzed = Analyzer::Analyze(*script_scan, *script_parsed, schema_analyzed.get());

            // Encode a program
            AnalyzerDumpTest::EncodeProgram(test, *script_analyzed, schema_analyzed.get());
        }

        // Write xml document
        doc.save(outs, "    ", pugi::format_default | pugi::format_no_declaration);
    }
}

int main(int argc, char* argv[]) {
    gflags::SetUsageMessage("Usage: ./dump_analyzer --source_dir <dir>");
    gflags::ParseCommandLineFlags(&argc, &argv, false);

    if (!std::filesystem::exists(FLAGS_source_dir)) {
        std::cout << "Invalid source directory: " << FLAGS_source_dir << std::endl;
    }
    auto source_dir = std::filesystem::path{FLAGS_source_dir};
    generate_analyzer_dumps(source_dir);
    return 0;
}
