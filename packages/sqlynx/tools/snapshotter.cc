#include <filesystem>
#include <fstream>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "flatbuffers/flatbuffers.h"
#include "gflags/gflags.h"
#include "sqlynx/analyzer/analyzer.h"
#include "sqlynx/catalog.h"
#include "sqlynx/parser/parser.h"
#include "sqlynx/parser/scanner.h"
#include "sqlynx/proto/proto_generated.h"
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

static std::unique_ptr<Script> read_script(pugi::xml_node node, size_t entry_id, Catalog* catalog = nullptr) {
    auto input = node.child("input").last_child().value();
    std::string database_name, schema_name;
    if (auto db = node.attribute("database")) {
        database_name = db.value();
    }
    if (auto schema = node.attribute("schema")) {
        schema_name = schema.value();
    }
    std::unique_ptr<Script> script;
    if (catalog == nullptr) {
        script = std::make_unique<Script>(entry_id, std::move(database_name), std::move(schema_name));
    } else {
        script = std::make_unique<Script>(*catalog, entry_id, std::move(database_name), std::move(schema_name));
    }
    script->InsertTextAt(0, input);
    auto scanned = script->Scan();
    if (scanned.second != proto::StatusCode::OK) {
        std::cout << "  ERROR " << proto::EnumNameStatusCode(scanned.second) << std::endl;
        return nullptr;
    }
    auto parsed = script->Parse();
    if (parsed.second != proto::StatusCode::OK) {
        std::cout << "  ERROR " << proto::EnumNameStatusCode(parsed.second) << std::endl;
        return nullptr;
    }
    auto analyzed = script->Analyze();
    if (analyzed.second != proto::StatusCode::OK) {
        std::cout << "  ERROR " << proto::EnumNameStatusCode(analyzed.second) << std::endl;
        return nullptr;
    }
    return script;
}

static std::unique_ptr<Catalog> read_catalog(pugi::xml_node catalog_node,
                                             std::vector<std::unique_ptr<Script>>& catalog_scripts, size_t& entry_id) {
    auto catalog = std::make_unique<Catalog>();
    for (auto entry_node : catalog_node.children()) {
        std::string entry_name = entry_node.name();

        if (entry_name == "script") {
            auto external_id = entry_id++;
            auto script = read_script(entry_node, external_id);
            catalog->LoadScript(*script, external_id);
            AnalyzerSnapshotTest::EncodeScript(entry_node, *script->analyzed_script, false);
            catalog_scripts.push_back(std::move(script));
        }
    }
    return catalog;
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

            std::vector<std::unique_ptr<Script>> catalog_scripts;
            size_t entry_id = 1;
            auto catalog = read_catalog(test_node.child("catalog"), catalog_scripts, entry_id);
            auto main_node = test_node.child("script");
            auto main_script = read_script(main_node, 0, catalog.get());

            AnalyzerSnapshotTest::EncodeScript(main_node, *main_script->analyzed_script, true);
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
            auto name = test.attribute("name").as_string();
            std::cout << "  TEST " << name << std::endl;

            std::vector<std::unique_ptr<Script>> catalog_scripts;
            size_t entry_id = 1;
            auto catalog = read_catalog(test.child("catalog"), catalog_scripts, entry_id);
            auto main_node = test.child("script");
            auto main_script = read_script(main_node, 0, catalog.get());
            AnalyzerSnapshotTest::EncodeScript(main_node, *main_script->analyzed_script, true);

            auto cursor_node = test.child("cursor");
            auto cursor_search_node = cursor_node.child("search");
            auto cursor_search_text = cursor_search_node.attribute("text").value();
            auto cursor_search_index = cursor_search_node.attribute("index").as_int();

            std::string_view target_text = main_script->scanned_script->GetInput();
            auto search_pos = target_text.find(cursor_search_text);
            if (search_pos == std::string_view::npos) {
                std::cout << "  ERROR couldn't locate cursor `" << cursor_search_text << "`" << std::endl;
                continue;
            }
            auto cursor_pos = search_pos + cursor_search_index;
            if (cursor_pos > target_text.size()) {
                std::cout << "  ERROR cursor index out of bounds " << cursor_pos << " > " << target_text.size()
                          << std::endl;
                continue;
            }

            auto completions_node = test.child("completions");
            auto limit = completions_node.attribute("limit").as_int(100);

            main_script->MoveCursor(cursor_pos);
            auto [completion, completion_status] = main_script->CompleteAtCursor(limit);
            if (completion_status != proto::StatusCode::OK) {
                std::cout << "  ERROR " << proto::EnumNameStatusCode(completion_status) << std::endl;
                continue;
            }

            // Encode the completion
            CompletionSnapshotTest::EncodeCompletion(completions_node, *completion);
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
