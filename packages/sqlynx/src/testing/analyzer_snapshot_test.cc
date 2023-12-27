#include "sqlynx/testing/analyzer_snapshot_test.h"

#include <algorithm>
#include <fstream>
#include <limits>

#include "gtest/gtest.h"
#include "sqlynx/analyzer/analyzer.h"
#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/script.h"
#include "sqlynx/testing/xml_tests.h"

namespace sqlynx {

using namespace testing;

/// Is a string with all lower-case alphanumeric characters?
static bool isAllLowercaseAlphaNum(std::string_view id) {
    bool all = true;
    for (auto c : id) {
        all &= (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
    }
    return all;
}

/// Write an identifier and quote it, if necessary
static void quoteIdentifier(std::string& buffer, std::string_view name) {
    if (isAllLowercaseAlphaNum(name)) {
        buffer += name;
    } else {
        buffer += '"';
        buffer += name;
        buffer += '"';
    }
}

// Resolve a name
static std::string_view resolveName(const AnalyzedScript& main, const AnalyzedScript* external, GlobalObjectID name) {
    if (name.IsNull()) {
        return "null";
    }
    if (name.GetOrigin() != main.GetOrigin()) {
        assert(external != nullptr);
        return external->parsed_script->scanned_script->ReadName(name.GetIndex()).text;
    } else {
        return main.parsed_script->scanned_script->ReadName(name.GetIndex()).text;
    }
}

/// Write all table declarations
static void writeTables(pugi::xml_node root, const AnalyzedScript& target) {
    for (auto& table_decl : target.GetTables()) {
        auto xml_tbl = root.append_child("table");
        std::string table_name{table_decl.table_name.table_name};
        xml_tbl.append_attribute("name").set_value(table_name.c_str());
        assert(table_decl.ast_node_id.has_value());
        WriteLocation(xml_tbl, target.parsed_script->nodes[*table_decl.ast_node_id].location(),
                      target.parsed_script->scanned_script->GetInput());
        // Write child columns
        for (size_t i = 0; i < table_decl.column_count; ++i) {
            auto table_idx = table_decl.columns_begin + i;
            auto& column_decl = target.GetTableColumns()[table_idx];
            auto xml_col = xml_tbl.append_child("column");
            if (!column_decl.column_name.empty()) {
                std::string column_name{column_decl.column_name};
                xml_col.append_attribute("name").set_value(column_name.c_str());
            } else {
                xml_col.append_attribute("name").set_value("?");
            }
            if (auto node_id = column_decl.ast_node_id; node_id.has_value()) {
                WriteLocation(xml_col, target.parsed_script->nodes[*node_id].location(),
                              target.parsed_script->scanned_script->GetInput());
            }
        }
    }
}

namespace testing {

void operator<<(std::ostream& out, const AnalyzerSnapshotTest& p) { out << p.name; }

void AnalyzerSnapshotTest::EncodeScript(pugi::xml_node out, const AnalyzedScript& script, bool is_main) {
    // Unpack modules
    auto* stmt_type_tt = proto::StatementTypeTypeTable();
    auto* node_type_tt = proto::NodeTypeTypeTable();

    // Get xml elements
    auto tables_node = out.append_child("tables");
    auto table_refs_node = out.append_child("table-references");
    auto col_refs_node = out.append_child("column-references");
    auto query_graph_node = out.append_child("query-graph");

    // Write local declarations
    writeTables(tables_node, script);

    // Write table references
    for (auto& ref : script.table_references) {
        auto tag = ref.resolved_table_id.IsNull()                                         ? "unresolved"
                   : (is_main && ref.resolved_table_id.GetOrigin() == script.GetOrigin()) ? "internal"
                                                                                          : "external";
        auto xml_ref = table_refs_node.append_child(tag);
        if (!ref.resolved_table_id.IsNull()) {
            xml_ref.append_attribute("table").set_value(ref.resolved_table_id.GetIndex());
        }
        if (ref.ast_statement_id.has_value()) {
            xml_ref.append_attribute("stmt").set_value(*ref.ast_statement_id);
        }
        assert(ref.ast_node_id.has_value());
        WriteLocation(xml_ref, script.parsed_script->nodes[*ref.ast_node_id].location(),
                      script.parsed_script->scanned_script->GetInput());
    }

    // Write column references
    for (auto& ref : script.column_references) {
        auto tag = ref.resolved_table_id.IsNull()                                         ? "unresolved"
                   : (is_main && ref.resolved_table_id.GetOrigin() == script.GetOrigin()) ? "internal"
                                                                                          : "external";
        auto xml_ref = col_refs_node.append_child(tag);
        if (!ref.resolved_table_id.IsNull()) {
            xml_ref.append_attribute("table").set_value(ref.resolved_table_id.GetIndex());
        }
        if (ref.resolved_column_id.has_value()) {
            xml_ref.append_attribute("column").set_value(*ref.resolved_column_id);
        }
        if (ref.ast_statement_id.has_value()) {
            xml_ref.append_attribute("stmt").set_value(*ref.ast_statement_id);
        }
        assert(ref.ast_node_id.has_value());
        WriteLocation(xml_ref, script.parsed_script->nodes[*ref.ast_node_id].location(),
                      script.parsed_script->scanned_script->GetInput());
    }

    // Write join edges
    for (auto& edge : script.graph_edges) {
        auto xml_edge = query_graph_node.append_child("edge");
        xml_edge.append_attribute("op").set_value(proto::EnumNameExpressionOperator(edge.expression_operator));
        assert(edge.ast_node_id.has_value());
        WriteLocation(xml_edge, script.parsed_script->nodes[*edge.ast_node_id].location(),
                      script.parsed_script->scanned_script->GetInput());
        for (size_t i = 0; i < edge.node_count_left; ++i) {
            auto& node = script.graph_edge_nodes[edge.nodes_begin + i];
            auto xml_node = xml_edge.append_child("node");
            xml_node.append_attribute("side").set_value(0);
            xml_node.append_attribute("ref").set_value(node.column_reference_id);
        }
        for (size_t i = 0; i < edge.node_count_right; ++i) {
            auto& node = script.graph_edge_nodes[edge.nodes_begin + edge.node_count_left + i];
            assert(!GlobalObjectID(script.GetOrigin(), node.column_reference_id).IsNull());
            auto xml_node = xml_edge.append_child("node");
            xml_node.append_attribute("side").set_value(1);
            xml_node.append_attribute("ref").set_value(node.column_reference_id);
        }
    }
}

// The files
static std::unordered_map<std::string, std::vector<AnalyzerSnapshotTest>> TEST_FILES;

/// Get the grammar tests
void AnalyzerSnapshotTest::LoadTests(std::filesystem::path& source_dir) {
    auto snapshots_dir = source_dir / "snapshots" / "analyzer";
    std::cout << "Loading analyzer tests at: " << snapshots_dir << std::endl;

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
        auto root = doc.child("analyzer-snapshots");

        // Read tests
        std::vector<AnalyzerSnapshotTest> tests;
        for (auto test_nodes : root.children()) {
            tests.emplace_back();
            auto& test = tests.back();
            test.name = test_nodes.attribute("name").as_string();

            {
                auto main_node = test_nodes.child("script");
                test.script.input = main_node.child("input").last_child().value();
                if (auto db = main_node.attribute("database")) {
                    test.script.database_name.emplace(db.value());
                }
                if (auto schema = main_node.attribute("schema")) {
                    test.script.schema_name.emplace(schema.value());
                }
                test.script.tables.append_copy(main_node.child("tables"));
                test.script.table_references.append_copy(main_node.child("table-references"));
                test.script.column_references.append_copy(main_node.child("column-references"));
                test.script.graph_edges.append_copy(main_node.child("query-graph"));
            }

            for (auto entry_node : test_nodes.child("registry").children()) {
                test.registry.emplace_back();
                auto& entry = test.registry.back();
                std::string entry_name = entry_node.name();
                if (entry_name == "script") {
                    entry.input = entry_node.child("input").last_child().value();
                    if (auto db = entry_node.attribute("database")) {
                        entry.database_name.emplace(db.value());
                    }
                    if (auto schema = entry_node.attribute("schema")) {
                        entry.schema_name.emplace(schema.value());
                    }
                    entry.tables.append_copy(entry_node.child("tables"));
                    entry.table_references.append_copy(entry_node.child("table-references"));
                    entry.column_references.append_copy(entry_node.child("column-references"));
                    entry.graph_edges.append_copy(entry_node.child("query-graph"));
                } else {
                    std::cout << "[    ERROR ] unknown test element " << entry_name << std::endl;
                }
            }
        }

        std::cout << "[ SETUP    ] " << filename << ": " << tests.size() << " tests" << std::endl;

        // Register test
        TEST_FILES.insert({filename, std::move(tests)});
    }
}

// Get the tests
std::vector<const AnalyzerSnapshotTest*> AnalyzerSnapshotTest::GetTests(std::string_view filename) {
    std::string name{filename};
    auto iter = TEST_FILES.find(name);
    if (iter == TEST_FILES.end()) {
        return {};
    }
    std::vector<const AnalyzerSnapshotTest*> tests;
    for (auto& test : iter->second) {
        tests.emplace_back(&test);
    }
    return tests;
}

}  // namespace testing
}  // namespace sqlynx
