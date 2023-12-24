#include <filesystem>
#include <fstream>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "flatbuffers/flatbuffers.h"
#include "gflags/gflags.h"
#include "sqlynx/analyzer/analyzer.h"
#include "sqlynx/parser/parser.h"
#include "sqlynx/parser/scanner.h"
#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/schema.h"
#include "sqlynx/script.h"
#include "sqlynx/testing/analyzer_snapshot_test.h"
#include "sqlynx/testing/completion_snapshot_test.h"
#include "sqlynx/testing/parser_snapshot_test.h"

using namespace sqlynx;
using namespace sqlynx::testing;

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
            auto [parsed, parserError] = parser::Parser::Parse(scanned.first);

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

        for (auto test_node : root.children()) {
            auto name = test_node.attribute("name").as_string();
            std::cout << "  TEST " << name << std::endl;

            // Load registry
            SchemaRegistry registry;
            std::vector<std::unique_ptr<Script>> registry_scripts;
            size_t entry_id = 1;
            for (auto entry_node : test_node.child("registry").children()) {
                std::string entry_name = entry_node.name();

                if (entry_name == "script") {
                    auto input = entry_node.child("input").last_child().value();
                    registry_scripts.push_back(std::make_unique<Script>(++entry_id));

                    auto& script = *registry_scripts.back();
                    script.InsertTextAt(0, input);
                    auto scanned = script.Scan();
                    if (scanned.second != proto::StatusCode::OK) {
                        std::cout << "  ERROR " << proto::EnumNameStatusCode(scanned.second) << std::endl;
                        continue;
                    }
                    auto parsed = script.Parse();
                    if (parsed.second != proto::StatusCode::OK) {
                        std::cout << "  ERROR " << proto::EnumNameStatusCode(parsed.second) << std::endl;
                        continue;
                    }
                    auto analyzed = script.Analyze();
                    if (analyzed.second != proto::StatusCode::OK) {
                        std::cout << "  ERROR " << proto::EnumNameStatusCode(analyzed.second) << std::endl;
                        continue;
                    }

                    registry.AddScript(script, entry_id);
                    AnalyzerSnapshotTest::EncodeScript(entry_node, *script.analyzed_script, false);
                }
            }

            // Load main script
            auto main_node = test_node.child("script");
            std::string main_text = main_node.child("input").last_child().value();

            Script main_script{0};
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
            auto main_analyzed = main_script.Analyze(&registry);
            if (main_analyzed.second != proto::StatusCode::OK) {
                std::cout << "  ERROR " << proto::EnumNameStatusCode(main_analyzed.second) << std::endl;
                continue;
            }

            AnalyzerSnapshotTest::EncodeScript(main_node, *main_analyzed.first, true);
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

            auto xml_main = test.find_child_by_attribute("script", "id", "1");
            auto xml_external = test.find_child_by_attribute("script", "id", "2");
            std::string main_text = xml_main.last_child().value();
            std::string external_text = xml_external.last_child().value();

            // Prepare the external script
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

            // Prepare the main script
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
            SchemaRegistry registry;
            registry.AddScript(external_script, 0);
            auto main_analyzed = main_script.Analyze(&registry);
            if (main_analyzed.second != proto::StatusCode::OK) {
                std::cout << "  ERROR " << proto::EnumNameStatusCode(main_analyzed.second) << std::endl;
                continue;
            }

            auto xml_cursor = test.child("cursor");
            std::string cursor_script = xml_cursor.attribute("script").value();
            auto xml_cursor_search = xml_cursor.child("search");
            auto cursor_search_text = xml_cursor_search.attribute("text").value();
            auto cursor_search_index = xml_cursor_search.attribute("index").as_int();

            size_t search_pos = 0;
            Script* target_script = nullptr;
            std::string_view target_text;

            if (cursor_script == "1") {
                search_pos = main_text.find(cursor_search_text);
                target_script = &main_script;
                target_text = main_text;

            } else if (cursor_script == "2") {
                search_pos = external_text.find(cursor_search_text);
                target_script = &external_script;
                target_text = external_text;

            } else {
                std::cout << "  ERROR invalid cursor target `" << cursor_script << "`" << std::endl;
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
