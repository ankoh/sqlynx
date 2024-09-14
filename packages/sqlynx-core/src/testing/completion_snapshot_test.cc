#include "sqlynx/testing/completion_snapshot_test.h"

#include <format>
#include <fstream>

#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/script.h"
#include "sqlynx/testing/xml_tests.h"
#include "sqlynx/text/names.h"

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
    root.append_attribute("strategy").set_value(ctxName);
    if (auto node_id = completion.GetCursor().ast_node_id) {
        root.append_attribute("symbol").set_value(
            proto::EnumNameNodeType(completion.GetCursor().script.parsed_script->nodes[*node_id].node_type()));
        root.append_attribute("relative")
            .set_value(proto::EnumNameRelativeSymbolPosition(completion.GetCursor().scanner_location->relative_pos));
    }
    for (auto iter = entries.rbegin(); iter != entries.rend(); ++iter) {
        auto xml_entry = root.append_child("entry");
        std::string text{iter->name.data(), iter->name.size()};
        xml_entry.append_attribute("value").set_value(text.c_str());
        xml_entry.append_attribute("score").set_value(iter->score);
        {
            std::stringstream name_tags;
            size_t i = 0;
            iter->coarse_name_tags.ForEach([&](proto::NameTag tag) {
                if (i++ > 0) {
                    name_tags << "|";
                }
                name_tags << proto::EnumNameNameTag(tag);
            });
            if (i > 0) {
                xml_entry.append_attribute("ntags").set_value(name_tags.str().c_str());
            }
        }
        {
            std::stringstream candidate_tags;
            size_t i = 0;
            iter->candidate_tags.ForEach([&](proto::CandidateTag tag) {
                if (i++ > 0) {
                    candidate_tags << "|";
                }
                candidate_tags << proto::EnumNameCandidateTag(tag);
            });
            if (i > 0) {
                xml_entry.append_attribute("ctags").set_value(candidate_tags.str().c_str());
            }
        }
        EncodeLocation(xml_entry, iter->replace_text_at, completion.GetCursor().script.scanned_script->text_buffer);
        for (auto& co : iter->catalog_objects) {
            auto& obj = co.catalog_object;
            auto xml_obj = xml_entry.append_child("object");
            switch (obj.object_type) {
                case sqlynx::CatalogObjectType::DatabaseReference: {
                    std::string type = "database";
                    auto* t = static_cast<const CatalogEntry::DatabaseReference*>(&obj);
                    xml_obj.append_attribute("type").set_value(type.c_str());
                    std::string catalog_id = std::format("{}", t->catalog_database_id);
                    xml_obj.append_attribute("id").set_value(catalog_id.c_str());
                    break;
                }
                case sqlynx::CatalogObjectType::SchemaReference: {
                    std::string type = "schema";
                    auto* t = static_cast<const CatalogEntry::SchemaReference*>(&obj);
                    xml_obj.append_attribute("type").set_value(type.c_str());
                    std::string catalog_id = std::format("{}.{}", t->catalog_database_id, t->catalog_schema_id);
                    xml_obj.append_attribute("id").set_value(catalog_id.c_str());
                    break;
                }
                case sqlynx::CatalogObjectType::TableDeclaration: {
                    std::string type = "table";
                    auto* t = static_cast<const CatalogEntry::TableDeclaration*>(&obj);
                    xml_obj.append_attribute("type").set_value(type.c_str());
                    std::string catalog_id = std::format("{}.{}.{}", t->catalog_database_id, t->catalog_schema_id,
                                                         t->catalog_table_id.Pack());
                    xml_obj.append_attribute("id").set_value(catalog_id.c_str());
                    break;
                }
                case sqlynx::CatalogObjectType::ColumnDeclaration: {
                    std::string type = "column";
                    auto& c = *static_cast<const CatalogEntry::TableColumn*>(&obj);
                    auto& t = c.table->get();
                    xml_obj.append_attribute("type").set_value(type.c_str());
                    std::string catalog_id = std::format("{}.{}.{}.{}", t.catalog_database_id, t.catalog_schema_id,
                                                         t.catalog_table_id.Pack(), c.column_index);
                    xml_obj.append_attribute("id").set_value(catalog_id.c_str());
                    break;
                }
                default:
                    assert(false);
            }
        }
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

            // Read catalog
            auto catalog_node = test_node.child("catalog");
            test.catalog_default_database = catalog_node.attribute("database").as_string();
            test.catalog_default_schema = catalog_node.attribute("schema").as_string();

            // Read main script
            {
                auto main_node = test_node.child("script");
                test.script.input = main_node.child("input").last_child().value();
                test.script.errors.append_copy(main_node.child("errors"));
                test.script.tables.append_copy(main_node.child("tables"));
                test.script.table_references.append_copy(main_node.child("tablerefs"));
                test.script.expressions.append_copy(main_node.child("expressions"));
            }

            // Read catalog
            for (auto entry_node : catalog_node.children()) {
                test.catalog_entries.emplace_back();
                auto& entry = test.catalog_entries.back();
                std::string entry_name = entry_node.name();
                if (entry_name == "script") {
                    entry.input = entry_node.child("input").last_child().value();
                    entry.errors.append_copy(entry_node.child("errors"));
                    entry.tables.append_copy(entry_node.child("tables"));
                    entry.table_references.append_copy(entry_node.child("tablerefs"));
                    entry.expressions.append_copy(entry_node.child("expressions"));
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
