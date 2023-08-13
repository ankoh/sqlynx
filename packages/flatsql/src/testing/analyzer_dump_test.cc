#include "flatsql/testing/analyzer_dump_test.h"

#include <algorithm>
#include <fstream>
#include <limits>

#include "flatsql/analyzer/analyzer.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/script.h"
#include "flatsql/testing/xml_tests.h"
#include "gtest/gtest.h"

namespace flatsql {

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
static std::string_view resolveName(const AnalyzedScript& main, const AnalyzedScript* external, Analyzer::ID name) {
    if (name.IsNull()) {
        return "null";
    }
    if (name.GetScriptId() != main.script_id) {
        assert(external != nullptr);
        return external->parsed_script->scanned_script->name_dictionary[name.GetIndex()].first;
    } else {
        return main.parsed_script->scanned_script->name_dictionary[name.GetIndex()].first;
    }
}

/// Write all table declarations
static void writeTables(pugi::xml_node root, const AnalyzedScript& target, const AnalyzedScript& main,
                        const AnalyzedScript* external) {
    for (auto& table_decl : target.tables) {
        auto xml_tbl = root.append_child("table");
        assert(table_decl.ast_node_id() != 0xFFFFFFFF);
        WriteLocation(xml_tbl, target.parsed_script->nodes[table_decl.ast_node_id()].location(),
                      target.parsed_script->scanned_script->GetInput());
        // Write child columns
        for (size_t i = 0; i < table_decl.column_count(); ++i) {
            auto table_idx = table_decl.columns_begin() + i;
            auto& column_decl = target.table_columns[table_idx];
            auto xml_col = xml_tbl.append_child("column");
            if (auto column_name_id = Analyzer::ID(column_decl.column_name(), Raw); column_name_id) {
                assert(!column_name_id.IsNull());
                assert(column_name_id.GetScriptId() == target.script_id);
                std::string column_name{
                    target.parsed_script->scanned_script->name_dictionary[column_name_id.GetIndex()].first};
                xml_col.append_attribute("name").set_value(column_name.c_str());
            } else {
                xml_col.append_attribute("name").set_value("?");
            }
            if (auto node_id = column_decl.ast_node_id(); node_id != 0xFFFFFFFF) {
                WriteLocation(xml_col, target.parsed_script->nodes[node_id].location(),
                              target.parsed_script->scanned_script->GetInput());
            }
        }
    }
}

namespace testing {

void AnalyzerDumpTest::EncodeScript(pugi::xml_node root, const AnalyzedScript& main, const AnalyzedScript* external) {
    // Unpack modules
    auto* stmt_type_tt = proto::StatementTypeTypeTable();
    auto* node_type_tt = proto::NodeTypeTypeTable();

    // Get xml elements
    auto xml_external = root.child("external");
    auto xml_main = root.child("main");

    auto xml_external_tables = xml_external.append_child("tables");
    auto xml_main_tables = xml_main.append_child("tables");
    auto xml_main_table_refs = xml_main.append_child("table-references");
    auto xml_main_col_refs = xml_main.append_child("column-references");
    auto xml_main_query_graph = xml_main.append_child("query-graph");

    // Write external tables (if there are any)
    if (external) {
        writeTables(xml_external_tables, *external, main, external);
    }

    // Write local declarations
    for (auto& table_decl : main.tables) {
        writeTables(xml_main_tables, main, main, external);
    }

    // Write table references
    for (auto& ref : main.table_references) {
        auto table_id = Analyzer::ID(ref.table_id(), Raw);
        auto tag = table_id.IsNull()                            ? "unresolved"
                   : (table_id.GetScriptId() == main.script_id) ? "internal"
                                                                : "external";
        auto xml_ref = xml_main_table_refs.append_child(tag);
        if (auto table_id = Analyzer::ID(ref.table_id(), Raw); table_id) {
            xml_ref.append_attribute("table").set_value(table_id.GetIndex());
        }
        assert(ref.ast_node_id() != 0xFFFFFFFF);
        WriteLocation(xml_ref, main.parsed_script->nodes[ref.ast_node_id()].location(),
                      main.parsed_script->scanned_script->GetInput());
    }

    // Write column references
    for (auto& ref : main.column_references) {
        auto table_id = Analyzer::ID(ref.table_id(), Raw);
        auto tag = table_id.IsNull()                            ? "unresolved"
                   : (table_id.GetScriptId() == main.script_id) ? "internal"
                                                                : "external";
        auto xml_ref = xml_main_col_refs.append_child(tag);
        if (auto table_id = Analyzer::ID(ref.table_id(), Raw); table_id) {
            xml_ref.append_attribute("table").set_value(table_id.GetIndex());
        }
        if (ref.column_id() != 0xFFFFFFFF) {
            xml_ref.append_attribute("column").set_value(ref.column_id());
        }
        assert(ref.ast_node_id() != 0xFFFFFFFF);
        WriteLocation(xml_ref, main.parsed_script->nodes[ref.ast_node_id()].location(),
                      main.parsed_script->scanned_script->GetInput());
    }

    // Write join edges
    for (auto& edge : main.graph_edges) {
        auto xml_edge = xml_main_query_graph.append_child("edge");
        xml_edge.append_attribute("op").set_value(proto::EnumNameExpressionOperator(edge.expression_operator()));
        WriteLocation(xml_edge, main.parsed_script->nodes[edge.ast_node_id()].location(),
                      main.parsed_script->scanned_script->GetInput());
        for (size_t i = 0; i < edge.node_count_left(); ++i) {
            auto& node = main.graph_edge_nodes[edge.nodes_begin() + i];
            auto xml_node = xml_edge.append_child("node");
            xml_node.append_attribute("side").set_value(0);
            xml_node.append_attribute("ref").set_value(node.column_reference_id());
        }
        for (size_t i = 0; i < edge.node_count_right(); ++i) {
            auto& node = main.graph_edge_nodes[edge.nodes_begin() + edge.node_count_left() + i];
            assert(!Analyzer::ID(main.script_id, node.column_reference_id()).IsNull());
            auto xml_node = xml_edge.append_child("node");
            xml_node.append_attribute("side").set_value(1);
            xml_node.append_attribute("ref").set_value(node.column_reference_id());
        }
    }
}

// The files
static std::unordered_map<std::string, std::vector<AnalyzerDumpTest>> TEST_FILES;

/// Get the grammar tests
void AnalyzerDumpTest::LoadTests(std::filesystem::path& source_dir) {
    auto dumps_dir = source_dir / "dumps" / "analyzer";
    std::cout << "Loading analyzer tests at: " << dumps_dir << std::endl;

    for (auto& p : std::filesystem::directory_iterator(dumps_dir)) {
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
        auto root = doc.child("analyzer-dumps");

        // Read tests
        std::vector<AnalyzerDumpTest> tests;
        for (auto test : root.children()) {
            // Create test
            tests.emplace_back();
            auto& t = tests.back();
            auto xml_external = test.child("external");
            auto xml_main = test.child("main");
            t.name = test.attribute("name").as_string();
            t.input_external = xml_external.child("input").last_child().value();
            t.input_main = xml_main.child("input").last_child().value();

            // Read xml elements
            t.tables.append_copy(xml_main.child("tables"));
            t.table_references.append_copy(xml_main.child("table-references"));
            t.column_references.append_copy(xml_main.child("column-references"));
            t.graph_edges.append_copy(xml_main.child("query-graph"));
        }

        std::cout << "[ SETUP    ] " << filename << ": " << tests.size() << " tests" << std::endl;

        // Register test
        TEST_FILES.insert({filename, std::move(tests)});
    }
}

// Get the tests
std::vector<const AnalyzerDumpTest*> AnalyzerDumpTest::GetTests(std::string_view filename) {
    std::string name{filename};
    auto iter = TEST_FILES.find(name);
    if (iter == TEST_FILES.end()) {
        return {};
    }
    std::vector<const AnalyzerDumpTest*> tests;
    for (auto& test : iter->second) {
        tests.emplace_back(&test);
    }
    return tests;
}

}  // namespace testing
}  // namespace flatsql
