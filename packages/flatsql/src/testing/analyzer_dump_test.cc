#include "flatsql/testing/analyzer_dump_test.h"

#include <algorithm>
#include <fstream>
#include <limits>

#include "flatsql/analyzer/analyzer.h"
#include "flatsql/program.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/testing/xml_tests.h"
#include "gtest/gtest.h"

namespace flatsql {

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
static std::string_view resolveName(const AnalyzedProgram& main, const AnalyzedProgram* external, Analyzer::ID name) {
    if (name.IsNull()) {
        return "null";
    }
    if (name.IsExternal()) {
        assert(external != nullptr);
        return external->scanned.name_dictionary[name.AsIndex()].first;
    } else {
        return main.scanned.name_dictionary[name.AsIndex()].first;
    }
}

/// Print a qualified name as a string
static std::string writeQualifiedName(const AnalyzedProgram& main, const AnalyzedProgram* external,
                                      const proto::QualifiedTableName& name) {
    std::string buffer;
    if (Analyzer::ID(name.schema_name())) {
        if (Analyzer::ID(name.database_name())) {
            quoteIdentifier(buffer, resolveName(main, external, Analyzer::ID(name.database_name())));
            buffer += ".";
        }
        quoteIdentifier(buffer, resolveName(main, external, Analyzer::ID(name.schema_name())));
        buffer += ".";
    }
    if (Analyzer::ID(name.table_name())) {
        quoteIdentifier(buffer, resolveName(main, external, Analyzer::ID(name.table_name())));
    }
    return buffer;
}

/// Print a qualified name
static std::string writeQualifiedName(const AnalyzedProgram& main, const AnalyzedProgram* external,
                                      const proto::QualifiedColumnName& name) {
    std::string buffer;
    if (Analyzer::ID(name.table_alias())) {
        quoteIdentifier(buffer, resolveName(main, external, Analyzer::ID(name.table_alias())));
        buffer += ".";
    }
    if (Analyzer::ID(name.column_name())) {
        quoteIdentifier(buffer, resolveName(main, external, Analyzer::ID(name.column_name())));
    }
    return buffer;
}

namespace testing {

void AnalyzerDumpTest::EncodeProgram(pugi::xml_node root, const AnalyzedProgram& main,
                                     const AnalyzedProgram* external) {
    // Unpack modules
    auto& nodes = main.parsed.nodes;
    auto& statements = main.parsed.statements;
    auto* stmt_type_tt = proto::StatementTypeTypeTable();
    auto* node_type_tt = proto::NodeTypeTypeTable();
    // Create xml elements
    auto tables = root.append_child("tables");
    auto table_refs = root.append_child("table-references");
    auto column_refs = root.append_child("column-references");
    auto join_edges = root.append_child("join-edges");

    // Write local declarations
    for (auto& table_decl : main.tables) {
        auto xml_tbl = tables.append_child("table");
        // Write table name
        if (Analyzer::ID(table_decl.table_name().table_name())) {
            auto table_name = writeQualifiedName(main, external, table_decl.table_name());
            xml_tbl.append_attribute("name").set_value(table_name.c_str());
        }
        // Is external?
        xml_tbl.append_attribute("external").set_value(!!Analyzer::ID(table_decl.ast_node_id()));
        // Has a node id?
        if (auto node_id = Analyzer::ID(table_decl.ast_node_id()); !node_id) {
            EncodeLocation(xml_tbl, nodes[node_id.AsIndex()].location(), main.scanned.GetInput());
        }
        // Write child columns
        for (size_t i = table_decl.columns_begin(); i < table_decl.column_count(); ++i) {
            auto& column_decl = main.table_columns[i];
            auto xml_col = xml_tbl.append_child("column");
            if (auto column_name_id = Analyzer::ID(column_decl.column_name()); column_name_id) {
                assert(!column_name_id.IsNull());
                assert(!column_name_id.IsExternal());
                std::string column_name{main.scanned.name_dictionary[column_name_id.AsIndex()].first};
                xml_col.append_attribute("name").set_value(column_name.c_str());
            } else {
                xml_col.append_attribute("name").set_value("?");
            }
            if (auto node_id = Analyzer::ID(column_decl.ast_node_id()); !node_id) {
                EncodeLocation(xml_col, nodes[node_id.AsIndex()].location(), main.scanned.GetInput());
            }
        }
    }

    // Write table references
    for (auto& ref : main.table_references) {
        auto xml_ref = table_refs.append_child("table-reference");
        if (auto table_id = Analyzer::ID(ref.table_id()); table_id) {
            xml_ref.append_attribute("table").set_value(table_id.AsIndex());
        }
        if (auto node_id = Analyzer::ID(ref.ast_node_id()); node_id) {
            EncodeLocation(xml_ref, nodes[node_id.AsIndex()].location(), main.scanned.GetInput());
        }
    }

    // Write column references
    for (auto& ref : main.column_references) {
        auto xml_ref = column_refs.append_child("column-reference");
        if (auto table_id = Analyzer::ID(ref.table_id()); table_id) {
            xml_ref.append_attribute("table").set_value(table_id.AsIndex());
        }
        if (auto column_id = Analyzer::ID(ref.column_id()); column_id) {
            xml_ref.append_attribute("column").set_value(column_id.AsIndex());
        }
        if (auto node_id = Analyzer::ID(ref.ast_node_id()); node_id) {
            EncodeLocation(xml_ref, nodes[node_id.AsIndex()].location(), main.scanned.GetInput());
        }
    }

    // Write join edges
    for (auto& edge : main.join_edges) {
        auto xml_edge = join_edges.append_child("join-edge");
        EncodeLocation(xml_edge, nodes[edge.ast_node_id()].location(), main.scanned.GetInput());
        for (size_t i = 0; i < edge.node_count_left(); ++i) {
            auto& node = main.join_edge_nodes[edge.nodes_begin() + i];
            auto xml_node = xml_edge.append_child("node");
            xml_node.append_attribute("at").set_value(0);
            xml_node.append_attribute("ref").set_value(node.column_reference_id());
        }
        for (size_t i = 0; i < edge.node_count_left(); ++i) {
            auto& node = main.join_edge_nodes[edge.nodes_begin() + edge.node_count_left() + i];
            auto xml_node = xml_edge.append_child("node");
            xml_node.append_attribute("at").set_value(1);
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
            t.name = test.attribute("name").as_string();
            t.schema = test.child("schema").last_child().value();
            t.script = test.child("script").last_child().value();

            // Read the tables
            pugi::xml_document tables;
            for (auto s : test.child("tables").children()) {
                tables.append_copy(s);
            }
            t.tables = std::move(tables);

            // Read the table refs
            pugi::xml_document table_refs;
            for (auto s : test.child("table-references").children()) {
                table_refs.append_copy(s);
            }
            t.table_references = std::move(table_refs);

            // Read the column refs
            pugi::xml_document column_refs;
            for (auto s : test.child("column-references").children()) {
                column_refs.append_copy(s);
            }
            t.column_references = std::move(column_refs);

            // Read the join edges
            pugi::xml_document join_edges;
            for (auto s : test.child("join-edges").children()) {
                join_edges.append_copy(s);
            }
            t.join_edges = std::move(join_edges);
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
