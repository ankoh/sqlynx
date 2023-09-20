#include <filesystem>
#include <fstream>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "flatbuffers/flatbuffers.h"
#include "flatsql/analyzer/analyzer.h"
#include "flatsql/parser/parse_context.h"
#include "flatsql/parser/scanner.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/script.h"
#include "flatsql/testing/analyzer_snapshot_test.h"
#include "flatsql/testing/completion_snapshot_test.h"
#include "flatsql/testing/parser_snapshot_test.h"
#include "gflags/gflags.h"

using namespace flatsql;
using namespace flatsql::testing;

DEFINE_string(source_dir, "", "Source directory");

static void generate_parser_snapshots(const std::filesystem::path& source_dir) {
    auto snapshot_dir = source_dir / "snapshots" / "parser";
    for (auto& p : std::filesystem::directory_iterator(snapshot_dir)) {
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
        auto root = doc.child("parser-snapshots");

        for (auto test : root.children()) {
            // Copy expected
            auto name = test.attribute("name").as_string();
            std::cout << "  TEST " << name << std::endl;

            /// Parse module
            auto input = test.child("input");
            auto input_buffer = std::string{input.last_child().value()};
            rope::Rope input_rope{1024, input_buffer};
            auto scanned = parser::Scanner::Scan(input_rope, 1);
            if (scanned.second != proto::StatusCode::OK) {
                std::cout << "  ERROR " << proto::EnumNameStatusCode(scanned.second) << std::endl;
                continue;
            }
            auto [parsed, parserError] = parser::ParseContext::Parse(scanned.first);

            /// Write output
            auto expected = test.append_child("expected");
            ParserSnapshotTest::EncodeScript(expected, *scanned.first, *parsed, input_buffer);
        }

        // Write xml document
        doc.save(outs, "    ", pugi::format_default | pugi::format_no_declaration);
    }
}

static void generate_analyzer_snapshots(const std::filesystem::path& source_dir) {
    auto snapshot_dir = source_dir / "snapshots" / "analyzer";
    for (auto& p : std::filesystem::directory_iterator(snapshot_dir)) {
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
        auto root = doc.child("analyzer-snapshots");

        for (auto test : root.children()) {
            // Copy expected
            auto name = test.attribute("name").as_string();
            std::cout << "  TEST " << name << std::endl;

            // Read the external script
            auto xml_external = test.find_child_by_attribute("script", "context", "external");
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
            auto xml_main = test.find_child_by_attribute("script", "context", "main");
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
            AnalyzerSnapshotTest::EncodeScript(test, *main_analyzed.first, external_analyzed.first.get());
        }

        // Write xml document
        doc.save(outs, "    ", pugi::format_default | pugi::format_no_declaration);
    }
}

static void generate_completion_snapshots(const std::filesystem::path& source_dir) {
    auto snapshot_dir = source_dir / "snapshots" / "completion";
    for (auto& p : std::filesystem::directory_iterator(snapshot_dir)) {
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
        auto root = doc.child("analyzer-snapshots");

        for (auto test : root.children()) {
            // Copy expected
            auto name = test.attribute("name").as_string();
            std::cout << "  TEST " << name << std::endl;

            // Read the external script
            auto xml_external = test.find_child_by_attribute("script", "context", "external");
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
            auto xml_main = test.find_child_by_attribute("script", "context", "main");
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
            // CompletionSnapshotTest::EncodeScript(test, *main_analyzed.first, external_analyzed.first.get());
            // XXX
        }

        // Write xml document
        doc.save(outs, "    ", pugi::format_default | pugi::format_no_declaration);
    }
}

int main(int argc, char* argv[]) {
    gflags::SetUsageMessage("Usage: ./snapshot_parser --source_dir <dir>");
    gflags::ParseCommandLineFlags(&argc, &argv, false);

    if (!std::filesystem::exists(FLAGS_source_dir)) {
        std::cout << "Invalid source directory: " << FLAGS_source_dir << std::endl;
    }
    auto source_dir = std::filesystem::path{FLAGS_source_dir};
    generate_parser_snapshots(source_dir);
    generate_analyzer_snapshots(source_dir);
    generate_completion_snapshots(source_dir);
    return 0;
}
