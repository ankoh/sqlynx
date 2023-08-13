#include <filesystem>
#include <fstream>
#include <string_view>

#include "flatsql/analyzer/analyzer.h"
#include "flatsql/parser/parse_context.h"
#include "flatsql/parser/scanner.h"
#include "flatsql/proto/proto_generated.h"
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

            // Read the external script
            auto xml_external = test.child("external");
            std::string external_text = xml_external.child("input").last_child().value();
            rope::Rope external_rope{1024, external_text};
            auto external_scan = parser::Scanner::Scan(external_rope, 2);
            if (external_scan.second != proto::StatusCode::OK) {
                std::cout << "  ERROR " << proto::EnumNameStatusCode(external_scan.second) << std::endl;
                continue;
            }
            auto external_parsed = parser::ParseContext::Parse(external_scan.first);
            if (external_parsed.second != proto::StatusCode::OK) {
                std::cout << "  ERROR " << proto::EnumNameStatusCode(external_parsed.second) << std::endl;
                continue;
            }
            auto external_analyzed = Analyzer::Analyze(external_parsed.first, nullptr);
            if (external_analyzed.second != proto::StatusCode::OK) {
                std::cout << "  ERROR " << proto::EnumNameStatusCode(external_analyzed.second) << std::endl;
                continue;
            }

            /// Read the script
            auto xml_main = test.child("main");
            std::string main_text = xml_main.child("input").last_child().value();
            rope::Rope main_rope{1024, main_text};
            auto main_scan = parser::Scanner::Scan(main_rope, 1);
            if (main_scan.second != proto::StatusCode::OK) {
                std::cout << "  ERROR " << proto::EnumNameStatusCode(main_scan.second) << std::endl;
                continue;
            }
            auto main_parsed = parser::ParseContext::Parse(main_scan.first);
            if (main_parsed.second != proto::StatusCode::OK) {
                std::cout << "  ERROR " << proto::EnumNameStatusCode(main_parsed.second) << std::endl;
                continue;
            }
            auto main_analyzed = Analyzer::Analyze(main_parsed.first, external_analyzed.first);
            if (main_analyzed.second != proto::StatusCode::OK) {
                std::cout << "  ERROR " << proto::EnumNameStatusCode(main_analyzed.second) << std::endl;
                continue;
            }

            // Encode a program
            AnalyzerDumpTest::EncodeScript(test, *main_analyzed.first, external_analyzed.first.get());
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
