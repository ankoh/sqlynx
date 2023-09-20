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
        auto root = doc.child("completion-snapshots");

        for (auto test : root.children()) {
            // Copy expected
            auto name = test.attribute("name").as_string();
            std::cout << "  TEST " << name << std::endl;

            // Prepare the external script
            auto xml_external = test.find_child_by_attribute("script", "context", "external");
            std::string external_text = xml_external.last_child().value();
            Script external_script{1};
            external_script.InsertTextAt(0, external_text);
            auto external_scan = external_script.Scan();
            if (external_scan.second != proto::StatusCode::OK) {
                std::cout << "  ERROR " << proto::EnumNameStatusCode(external_scan.second) << std::endl;
                continue;
            }
            auto external_parsed = external_script.Parse();
            if (external_parsed.second != proto::StatusCode::OK) {
                std::cout << "  ERROR " << proto::EnumNameStatusCode(external_parsed.second) << std::endl;
                continue;
            }
            auto external_analyzed = external_script.Analyze();
            if (external_analyzed.second != proto::StatusCode::OK) {
                std::cout << "  ERROR " << proto::EnumNameStatusCode(external_analyzed.second) << std::endl;
                continue;
            }
            if (auto status = external_script.Reindex(); status != proto::StatusCode::OK) {
                std::cout << "  ERROR " << proto::EnumNameStatusCode(status) << std::endl;
                continue;
            };

            // Prepare the main script
            auto xml_main = test.find_child_by_attribute("script", "context", "main");
            std::string main_text = xml_main.last_child().value();
            Script main_script{2};
            main_script.InsertTextAt(0, main_text);
            auto main_scan = main_script.Scan();
            if (main_scan.second != proto::StatusCode::OK) {
                std::cout << "  ERROR " << proto::EnumNameStatusCode(main_scan.second) << std::endl;
                continue;
            }
            auto main_parsed = main_script.Parse();
            if (main_parsed.second != proto::StatusCode::OK) {
                std::cout << "  ERROR " << proto::EnumNameStatusCode(main_parsed.second) << std::endl;
                continue;
            }
            auto main_analyzed = main_script.Analyze(&external_script);
            if (main_analyzed.second != proto::StatusCode::OK) {
                std::cout << "  ERROR " << proto::EnumNameStatusCode(main_analyzed.second) << std::endl;
                continue;
            }
            if (auto status = main_script.Reindex(); status != proto::StatusCode::OK) {
                std::cout << "  ERROR " << proto::EnumNameStatusCode(status) << std::endl;
                continue;
            };

            auto xml_cursor = test.child("cursor");
            std::string cursor_context = xml_cursor.attribute("context").value();
            auto xml_cursor_search = xml_cursor.child("search");
            auto cursor_search_text = xml_cursor_search.attribute("text").value();
            auto cursor_search_index = xml_cursor_search.attribute("index").as_int();

            size_t search_pos = 0;
            Script* target_script = nullptr;
            std::string_view target_text;

            if (cursor_context == "main") {
                search_pos = main_text.find(cursor_search_text);
                target_script = &main_script;
                target_text = main_text;

            } else if (cursor_context == "external") {
                search_pos = external_text.find(cursor_search_text);
                target_script = &external_script;
                target_text = external_text;

            } else {
                std::cout << "  ERROR invalid cursor context `" << cursor_context << "`" << std::endl;
                continue;
            }

            if (search_pos == std::string::npos) {
                std::cout << "  ERROR couldn't locate cursor `" << cursor_search_text << "`" << std::endl;
                continue;
            }
            auto cursor_pos = search_pos + cursor_search_index;
            if (cursor_pos > target_text.size()) {
                std::cout << "  ERROR cursor index out of bounds " << cursor_pos << " > " << target_text.size()
                          << std::endl;
                continue;
            }

            auto xml_completions = test.child("completions");
            auto limit = xml_completions.attribute("limit").as_int(100);

            target_script->MoveCursor(cursor_pos);
            auto [completion, completion_status] = target_script->CompleteAtCursor(limit);
            if (completion_status != proto::StatusCode::OK) {
                std::cout << "  ERROR " << proto::EnumNameStatusCode(completion_status) << std::endl;
                continue;
            }

            // Encode the completion
            CompletionSnapshotTest::EncodeCompletion(xml_completions, *completion);
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
