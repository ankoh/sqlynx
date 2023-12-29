#include "sqlynx/testing/completion_snapshot_test.h"

#include <algorithm>
#include <fstream>
#include <limits>

#include "gtest/gtest.h"
#include "sqlynx/analyzer/analyzer.h"
#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/script.h"
#include "sqlynx/testing/xml_tests.h"

namespace sqlynx {
namespace testing {

// The files
static std::unordered_map<std::string, std::vector<CompletionSnapshotTest>> TEST_FILES;

// Get the tests
std::vector<const CompletionSnapshotTest*> CompletionSnapshotTest::GetTests(std::string_view filename) {
    std::string name{filename};
    auto iter = TEST_FILES.find(name);
    if (iter == TEST_FILES.end()) {
        return {};
    }
    std::vector<const CompletionSnapshotTest*> tests;
    for (auto& test : iter->second) {
        tests.emplace_back(&test);
    }
    return tests;
}

/// Encode a script
void CompletionSnapshotTest::EncodeCompletion(pugi::xml_node root, const Completion& completion) {
    auto entries = completion.GetHeap().GetEntries();
    auto ctxName = proto::EnumNameCompletionStrategy(completion.GetStrategy());
    if (auto node_id = completion.GetCursor().ast_node_id) {
        root.append_attribute("symbol").set_value(
            proto::EnumNameNodeType(completion.GetCursor().script.parsed_script->nodes[*node_id].node_type()));
    }
    root.append_attribute("relative")
        .set_value(proto::EnumNameRelativeSymbolPosition(completion.GetCursor().scanner_location->relative_pos));
    root.append_attribute("strategy").set_value(ctxName);
    for (auto iter = entries.rbegin(); iter != entries.rend(); ++iter) {
        auto xml_entry = root.append_child("entry");
        std::string text{iter->name.text.data(), iter->name.text.size()};
        xml_entry.append_attribute("value").set_value(text.c_str());
        xml_entry.append_attribute("score").set_value(iter->GetScore());
        xml_entry.append_attribute("near").set_value(iter->near_cursor);
        std::stringstream tags;
        size_t i = 0;
        iter->combined_tags.ForEach([&](proto::NameTag tag) {
            if (i++ > 0) {
                tags << ",";
            }
            tags << proto::EnumNameNameTag(tag);
        });
        xml_entry.append_attribute("tags").set_value(tags.str().c_str());
    }
}

/// Get the grammar tests
void CompletionSnapshotTest::LoadTests(std::filesystem::path& source_dir) {
    auto snapshots_dir = source_dir / "snapshots" / "completion";
    std::cout << "Loading completion tests at: " << snapshots_dir << std::endl;

    for (auto& p : std::filesystem::directory_iterator(snapshots_dir)) {
        auto filename = p.path().filename().string();
        if (p.path().extension().string() != ".xml") continue;

        // Make sure that it's no template
        auto tpl = p.path();
        tpl.replace_extension();
        if (tpl.extension() == ".tpl") continue;

        // Open input stream
        std::ifstream in(p.path(), std::ios::in | std::ios::binary);
        if (!in) {
            std::cout << "[ SETUP    ] failed to read test file: " << filename << std::endl;
            continue;
        }

        // Parse xml document
        pugi::xml_document doc;
        doc.load(in);
        auto root = doc.child("completion-snapshots");

        // Read tests
        std::vector<CompletionSnapshotTest> tests;
        for (auto test_node : root.children()) {
            tests.emplace_back();
            auto& test = tests.back();
            test.name = test_node.attribute("name").as_string();

            // Read main script
            {
                auto main_node = test_node.child("script");
                if (auto db = main_node.attribute("database")) {
                    test.script.database_name = db.value();
                }
                if (auto schema = main_node.attribute("schema")) {
                    test.script.schema_name = schema.value();
                }
                test.script.input = main_node.child("input").last_child().value();
                test.script.tables.append_copy(main_node.child("tables"));
                test.script.table_references.append_copy(main_node.child("table-references"));
                test.script.column_references.append_copy(main_node.child("column-references"));
                test.script.graph_edges.append_copy(main_node.child("query-graph"));
            }

            // Read catalog
            for (auto entry_node : test_node.child("catalog").children()) {
                test.catalog.emplace_back();
                auto& entry = test.catalog.back();
                std::string entry_name = entry_node.name();
                if (entry_name == "script") {
                    if (auto db = entry_node.attribute("database")) {
                        entry.database_name = db.value();
                    }
                    if (auto schema = entry_node.attribute("schema")) {
                        entry.schema_name = schema.value();
                    }
                    entry.input = entry_node.child("input").last_child().value();
                    entry.tables.append_copy(entry_node.child("tables"));
                    entry.table_references.append_copy(entry_node.child("table-references"));
                    entry.column_references.append_copy(entry_node.child("column-references"));
                    entry.graph_edges.append_copy(entry_node.child("query-graph"));
                } else {
                    std::cout << "[    ERROR ] unknown test element " << entry_name << std::endl;
                }
            }

            // Read the cursor
            auto xml_cursor = test_node.child("cursor");
            auto xml_cursor_search = xml_cursor.child("search");
            test.cursor_script = xml_cursor.attribute("script").value();
            test.cursor_search_string = xml_cursor_search.attribute("text").value();
            test.cursor_search_index = xml_cursor_search.attribute("index").as_int();

            // Read the expected completions
            auto completions = test_node.child("completions");
            test.completion_limit = completions.attribute("limit").as_int();
            test.completions.append_copy(completions);
        }

        std::cout << "[ SETUP    ] " << filename << ": " << tests.size() << " tests" << std::endl;

        // Register test
        TEST_FILES.insert({filename, std::move(tests)});
    }
}

}  // namespace testing
}  // namespace sqlynx
