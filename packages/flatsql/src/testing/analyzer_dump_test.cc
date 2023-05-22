#include "flatsql/testing/analyzer_dump_test.h"

#include <limits>

#include "flatsql/proto/proto_generated.h"
#include "flatsql/testing/xml_tests.h"

static constexpr uint32_t NULL_ID = std::numeric_limits<uint32_t>::max();

namespace flatsql {

/// Print a qualified name as a string
static std::string printQualifiedName(const proto::ProgramT& program, proto::QualifiedTableName& name) {
    std::string buffer;
    if (name.schema_name() != NULL_ID) {
        if (name.database_name() != NULL_ID) {
            buffer += program.name_dictionary[name.database_name()];
            buffer += ".";
        }
        buffer += program.name_dictionary[name.schema_name()];
        buffer += ".";
    }
    if (name.table_name() != NULL_ID) {
        buffer += program.name_dictionary[name.table_name()];
    }
}

namespace testing {

void AnalyzerDumpTest::EncodeProgram(pugi::xml_node root, const proto::ProgramT& program, std::string_view text) {
    // Unpack modules
    auto& nodes = program.nodes;
    auto& statements = program.statements;
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
    auto& name_res = *program.name_resolution;

    for (auto& table_decl : name_res.table_declarations) {
        auto table = tables.append_child("table");
        // Write table name
        auto table_name = printQualifiedName(program, *table_decl->table_name);
        table.append_attribute("name").set_value(table_name.c_str());
        // Is external?
        table.append_attribute("external").set_value(table_decl->is_external);
        // Has a node id?
        if (auto node_id = table_decl->ast_node_id; node_id != NULL_ID) {
            auto& ast_node = program.nodes[node_id];
            EncodeLocation(table, ast_node.location(), text);
        }
        // Write child columns
        for (auto& column_decl : table_decl->columns) {
            auto column = table.append_child("column");
            if (column_decl.column_name() != NULL_ID) {
                auto column_name = program.name_dictionary[column_decl.column_name()];
                column.append_attribute("name").set_value(column_name.c_str());
            } else {
                column.append_attribute("name").set_value("?");
            }
            if (auto node_id = column_decl.ast_node_id(); node_id != NULL_ID) {
                auto& ast_node = program.nodes[node_id];
                EncodeLocation(column, ast_node.location(), text);
            }
        }
        // XXX
    }
}

}  // namespace testing
}  // namespace flatsql
