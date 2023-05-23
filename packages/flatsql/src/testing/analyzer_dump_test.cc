#include "flatsql/testing/analyzer_dump_test.h"

#include <fstream>
#include <limits>

#include "flatsql/program.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/testing/xml_tests.h"
#include "gtest/gtest.h"

namespace flatsql {

/// Is a string with all lower-case alphanumeric characters?
static bool isAllLowercaseAlphaNum(std::string_view id) {
    bool all = true;
    for (auto c : id) {
        all &= c >= 'a' && c <= 'z' && c >= '0' && c <= '9';
    }
    return all;
}

/// Write an identifier and quote it, if necessary
static void writeMaybeQuotedIdentifier(std::string& buffer, std::string_view name) {
    if (isAllLowercaseAlphaNum(name)) {
        buffer += name;
    } else {
        buffer += '"';
        buffer += name;
        buffer += '"';
    }
}

/// Print a qualified name as a string
static std::string printQualifiedName(const proto::ProgramT& program, const proto::QualifiedTableName& name) {
    std::string buffer;
    if (name.schema_name() != NULL_ID) {
        if (name.database_name() != NULL_ID) {
            writeMaybeQuotedIdentifier(buffer, program.name_dictionary[name.database_name()]);
            buffer += ".";
        }
        writeMaybeQuotedIdentifier(buffer, program.name_dictionary[name.schema_name()]);
        buffer += ".";
    }
    if (name.table_name() != NULL_ID) {
        writeMaybeQuotedIdentifier(buffer, program.name_dictionary[name.table_name()]);
    }
    return buffer;
}

/// Print a qualified name
static std::string printQualifiedName(const proto::ProgramT& program, const proto::QualifiedColumnName& name) {
    std::string buffer;
    if (name.table_name() != NULL_ID) {
        if (name.schema_name() != NULL_ID) {
            if (name.database_name() != NULL_ID) {
                writeMaybeQuotedIdentifier(buffer, program.name_dictionary[name.database_name()]);
                buffer += ".";
            }
            writeMaybeQuotedIdentifier(buffer, program.name_dictionary[name.schema_name()]);
            buffer += ".";
        }
        writeMaybeQuotedIdentifier(buffer, program.name_dictionary[name.table_name()]);
        buffer += ".";
    }
    if (name.column_name() != NULL_ID) {
        writeMaybeQuotedIdentifier(buffer, program.name_dictionary[name.column_name()]);
    }
    return buffer;
}

namespace testing {

void AnalyzerDumpTest::EncodeProgram(pugi::xml_node root, const proto::ProgramT& program, std::string_view text) {
    // Unpack modules
    auto& nodes = program.nodes;
    auto& statements = program.statements;
    auto& name_res = *program.name_resolution;
    auto* stmt_type_tt = proto::StatementTypeTypeTable();
    auto* node_type_tt = proto::NodeTypeTypeTable();

    // Create xml elements
    auto tables = root.append_child("tables");
    auto table_refs = root.append_child("table-references");
    auto column_refs = root.append_child("column-references");
    auto join_edges = root.append_child("join-edges");

    // Name resolution missing?
    if (!program.name_resolution) {
        return;
    }

    // Write table declarations
    for (auto& table_decl : name_res.table_declarations) {
        auto xml_tbl = tables.append_child("table");
        // Write table name
        auto table_name = printQualifiedName(program, *table_decl->table_name);
        xml_tbl.append_attribute("name").set_value(table_name.c_str());
        // Is external?
        xml_tbl.append_attribute("external").set_value(table_decl->is_external);
        // Has a node id?
        if (auto node_id = table_decl->ast_node_id; node_id != NULL_ID) {
            EncodeLocation(xml_tbl, program.nodes[node_id].location(), text);
        }
        // Write child columns
        for (auto& column_decl : table_decl->columns) {
            auto xml_col = xml_tbl.append_child("column");
            if (column_decl.column_name() != NULL_ID) {
                auto column_name = program.name_dictionary[column_decl.column_name()];
                xml_col.append_attribute("name").set_value(column_name.c_str());
            } else {
                xml_col.append_attribute("name").set_value("?");
            }
            if (auto node_id = column_decl.ast_node_id(); node_id != NULL_ID) {
                EncodeLocation(xml_col, program.nodes[node_id].location(), text);
            }
        }
    }

    // Write table references
    for (auto& ref : name_res.table_references) {
        auto xml_ref = table_refs.append_child("table-reference");
        auto table_name = printQualifiedName(program, ref.table_name());
        xml_ref.append_attribute("name").set_value(table_name.c_str());
        if (auto table_id = ref.resolved_table_id(); table_id != NULL_ID) {
            xml_ref.append_attribute("table").set_value(table_id);
        }
        if (auto node_id = ref.ast_node_id(); node_id != NULL_ID) {
            EncodeLocation(xml_ref, program.nodes[node_id].location(), text);
        }
    }

    // Write column references
    for (auto& ref : name_res.column_references) {
        auto xml_ref = column_refs.append_child("column-reference");
        auto table_name = printQualifiedName(program, ref.column_name());
        xml_ref.append_attribute("name").set_value(table_name.c_str());
        if (auto table_id = ref.resolved_table_id(); table_id != NULL_ID) {
            xml_ref.append_attribute("table").set_value(table_id);
        }
        if (auto column_id = ref.resolved_column_id(); column_id != NULL_ID) {
            xml_ref.append_attribute("column").set_value(column_id);
        }
        if (auto node_id = ref.ast_node_id(); node_id != NULL_ID) {
            EncodeLocation(xml_ref, program.nodes[node_id].location(), text);
        }
    }

    // Write join edges
    for (auto& edge : name_res.join_edges) {
        auto xml_edge = join_edges.append_child("join-edge");
        if (auto node_id = edge->ast_node_id; node_id != NULL_ID) {
            EncodeLocation(xml_edge, program.nodes[node_id].location(), text);
        }
        auto writeNodes = [](pugi::xml_node& edge, const proto::ProgramT& program, std::string_view text,
                             const std::vector<flatsql::proto::HyperGraphNode>& nodes, size_t at) {
            for (auto node : nodes) {
                auto xml_node = edge.append_child("node");
                xml_node.append_attribute("at").set_value(0);
                xml_node.append_attribute("table").set_value(node.table_id());
                xml_node.append_attribute("column").set_value(node.column_id());
                assert(node.ast_node_id() != NULL_ID);
                EncodeLocation(xml_node, program.nodes[node.ast_node_id()].location(), text);
            }
        };
        writeNodes(xml_edge, program, text, edge->nodes_0, 0);
        writeNodes(xml_edge, program, text, edge->nodes_1, 1);
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
