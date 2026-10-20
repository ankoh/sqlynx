#include "dashql/testing/analyzer_snapshot_test.h"

#include <format>
#include <fstream>
#include <sstream>

#include "c4/format.hpp"
#include "c4/yml/std/std.hpp"
#include "dashql/buffers/index_generated.h"
#include "dashql/script.h"
#include "dashql/testing/runfiles_dir.h"
#include "dashql/testing/yaml_tests.h"
#include "dashql/utils/string_trimming.h"
#include "gtest/gtest.h"
#include "ryml.hpp"

namespace dashql {

using namespace testing;

/// Helper template for static_assert in generic visitor
template <typename T> constexpr bool always_false = false;

/// Is a string with all lower-case alphanumeric characters?
static bool isAllLowercaseAlphaNum(std::string_view id) {
    bool all = true;
    for (auto c : id) {
        all &= (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
    }
    return all;
}

/// Write an identifier and quote it, if necessary
[[maybe_unused]] static void quoteIdentifier(std::string& buffer, std::string_view name) {
    if (isAllLowercaseAlphaNum(name)) {
        buffer += name;
    } else {
        buffer += '"';
        buffer += name;
        buffer += '"';
    }
}

/// Write all table declarations to YAML (root is a SEQ node)
static void writeTables(c4::yml::NodeRef root, const AnalyzedScript& target) {
    target.GetTables().ForEach([&](size_t ti, const CatalogEntry::TableDeclaration& table_decl) {
        auto [db_id, schema_id] = table_decl.catalog_schema_id.UnpackSchemaID();
        auto table_id = table_decl.object_id.UnpackTableID();
        std::string table_catalog_id = std::format("{}.{}.{}", db_id, schema_id, table_id.Pack());

        auto yml_tbl = root.append_child();
        yml_tbl.set_type(c4::yml::MAP);
        auto id_node = yml_tbl.append_child();
        id_node << c4::yml::key("catalog-id") << table_catalog_id;
        id_node.set_val_style(c4::yml::VAL_DQUO);  // quote so YAML does not parse as float
        std::string table_name{table_decl.table_name.table_name.get().text};
        yml_tbl.append_child() << c4::yml::key("name") << table_name;
        assert(table_decl.ast_node_id.has_value());
        EncodeLocationText(yml_tbl,
                           target.parsed_script->scanned_script->ResolveTextSpan(
                               target.parsed_script->nodes[*table_decl.ast_node_id].symbol_span()),
                           target.parsed_script->scanned_script->GetInput());
        // Write child columns
        auto columns_node = yml_tbl.append_child();
        columns_node << c4::yml::key("columns");
        columns_node |= c4::yml::SEQ;
        for (size_t i = 0; i < table_decl.table_columns.size(); ++i) {
            auto& column_decl = table_decl.table_columns[i];
            auto yml_col = columns_node.append_child();
            yml_col.set_type(c4::yml::MAP);
            std::string column_catalog_id = std::format("{}.{}", table_catalog_id, i);
            auto col_id_node = yml_col.append_child();
            col_id_node << c4::yml::key("catalog-id") << column_catalog_id;
            col_id_node.set_val_style(c4::yml::VAL_DQUO);  // quote so YAML does not parse as float
            if (!column_decl.column_name.get().text.empty()) {
                std::string column_name{column_decl.column_name.get().text};
                yml_col.append_child() << c4::yml::key("name") << column_name;
            } else {
                yml_col.append_child() << c4::yml::key("name") << "?";
            }
            if (auto node_id = column_decl.ast_node_id; node_id.has_value()) {
                EncodeLocationText(yml_col,
                                   target.parsed_script->scanned_script->ResolveTextSpan(
                                       target.parsed_script->nodes[*node_id].symbol_span()),
                                   target.parsed_script->scanned_script->GetInput());
            }
        }
    });
}

namespace testing {

void AnalyzerSnapshotTest::ScriptAnalysisSnapshot::ReadFrom(c4::yml::ConstNodeRef script_node) {
    if (script_node.has_child("input")) {
        c4::csubstr v = script_node["input"].val();
        if (v.str) {
            std::string_view trimmed = trim_view_right(
                trim_view_left(std::string_view{v.str, v.len}, is_no_space), is_no_newline);
            input.assign(trimmed.data(), trimmed.size());
        }
    }
}

void AnalyzerSnapshotTest::TestCatalogSnapshot(const std::vector<ScriptAnalysisSnapshot>& snaps,
                                               c4::yml::NodeRef catalog_node, Catalog& catalog,
                                               std::vector<std::unique_ptr<Script>>& catalog_scripts) {
    for (size_t i = 0; i < snaps.size(); ++i) {
        auto& entry = snaps[i];

        // Create a new script
        catalog_scripts.push_back(std::make_unique<Script>(catalog));
        auto& script = *catalog_scripts.back();

        // Encode and compare to expected
        auto script_key_node = catalog_node.append_child();
        script_key_node << c4::yml::key("script");
        script_key_node |= c4::yml::MAP;
        TestScriptSnapshot(entry, script_key_node, script, false);

        // Add script to catalog.
        size_t rank = script.GetCatalogEntryId();
        catalog.LoadScript(script, rank);
    }
}

void AnalyzerSnapshotTest::TestScriptSnapshot(const ScriptAnalysisSnapshot& snap, c4::yml::NodeRef node, Script& script,
                                              bool is_main) {
    script.InsertTextAt(0, snap.input);

    script.Scan();
    script.Parse();
    script.Analyze();

    AnalyzerSnapshotTest::EncodeScript(node, *script.analyzed_script, is_main);

    if (snap.tree && snap.node_id != c4::yml::NONE) {
        auto expected = snap.tree->ref(snap.node_id);
        const char* keys[] = {"errors", "tables", "table-refs", "inserts", "expressions", "constants", "inferred-tables"};
        for (const char* key : keys) {
            if (!expected.has_child(key)) continue;
            auto have = node[key];
            auto want = expected[key];
            if (have.invalid() && want.invalid()) continue;
            ASSERT_TRUE(Matches(have, want)) << "key: " << key;
        }
    }
}

void operator<<(std::ostream& out, const AnalyzerSnapshotTest& p) { out << p.name; }

void AnalyzerSnapshotTest::EncodeScript(c4::yml::NodeRef out, const AnalyzedScript& script, bool is_main) {
    out.append_child() << c4::yml::key("catalog-id") << script.GetCatalogEntryId();

    // Write local declarations
    if (script.GetTables().GetSize() > 0) {
        auto tables_node = out.append_child();
        tables_node << c4::yml::key("tables");
        tables_node |= c4::yml::SEQ;
        writeTables(tables_node, script);
    }
    // Encode errors (flow style when empty so empty seq emits as [] and matches snapshot)
    auto errors_node = out.append_child();
    errors_node << c4::yml::key("errors");
    errors_node |= c4::yml::SEQ;
    if (script.errors.empty()) errors_node.set_container_style(c4::yml::FLOW_SL);
    for (auto& error : script.errors) {
        auto error_node = errors_node.append_child();
        error_node.set_type(c4::yml::MAP);
        error_node.append_child() << c4::yml::key("type")
                                  << std::string(buffers::analyzer::EnumNameAnalyzerErrorType(error.error_type));
        // Only dump non-default (WARNING) severities to avoid churning the many ERROR snapshots.
        if (error.severity != buffers::analyzer::AnalyzerErrorSeverity::ERROR) {
            error_node.append_child()
                << c4::yml::key("severity")
                << std::string(buffers::analyzer::EnumNameAnalyzerErrorSeverity(error.severity));
        }
        error_node.append_child() << c4::yml::key("message") << error.message;
        // Warnings about comment tags only carry a text span
        auto error_span = error.symbol_span
                              ? script.parsed_script->scanned_script->ResolveTextSpan(*error.symbol_span)
                              : (error.text_span ? *error.text_span : buffers::parser::TextSpan());
        EncodeLocationText(error_node, error_span, script.parsed_script->scanned_script->GetInput());
    }
    // Write table references
    if (!script.table_references.IsEmpty()) {
        auto table_refs_node = out.append_child();
        table_refs_node << c4::yml::key("table-refs");
        table_refs_node |= c4::yml::SEQ;
        script.table_references.ForEach([&](size_t i, const AnalyzedScript::TableReference& ref) {
            auto yml_ref = table_refs_node.append_child();
            yml_ref.set_type(c4::yml::MAP);
            std::visit(
                [&](const auto& value) {
                    using T = std::decay_t<decltype(value)>;
                    if constexpr (std::is_same_v<T, std::monostate>) {
                    } else if constexpr (std::is_same_v<T, AnalyzedScript::TableReference::RelationExpression>) {
                        auto& relation_expr = value;
                        if (!relation_expr.resolved_table.has_value()) {
                            yml_ref.append_child() << c4::yml::key("type") << "name/unresolved";
                        } else {
                            auto& resolved = relation_expr.resolved_table.value();
                            auto [db_id, schema_id] = resolved.catalog_schema_id.UnpackSchemaID();
                            auto table_id = resolved.catalog_table_id.UnpackTableID();
                            std::string catalog_id = std::format("{}.{}.{}", db_id, schema_id, table_id.Pack());
                            auto type = is_main && table_id.GetOrigin() == script.GetCatalogEntryId() ? "name/internal"
                                                                                                      : "name/catalog";
                            yml_ref.append_child() << c4::yml::key("type") << type;
                            auto ref_id_node = yml_ref.append_child();
                            ref_id_node << c4::yml::key("catalog-id") << catalog_id;
                            ref_id_node.set_val_style(c4::yml::VAL_DQUO);  // quote so YAML does not parse as float
                        }
                    } else {
                        static_assert(always_false<T>, "Unhandled table reference type in analyzer snapshot test");
                    }
                },
                ref.inner);
            if (ref.ast_statement_id.has_value()) {
                yml_ref.append_child() << c4::yml::key("statement-id") << *ref.ast_statement_id;
            }
            if (ref.role == TableReference::Role::Write) {
                yml_ref.append_child() << c4::yml::key("role") << "write";
            }
            EncodeLocationText(yml_ref,
                               script.parsed_script->scanned_script->ResolveTextSpan(
                                   script.parsed_script->nodes[ref.ast_node_id].symbol_span()),
                               script.parsed_script->scanned_script->GetInput());
        });
    }

    if (!script.insert_statements.IsEmpty()) {
        auto inserts_node = out.append_child();
        inserts_node << c4::yml::key("inserts");
        inserts_node |= c4::yml::SEQ;
        script.insert_statements.ForEach([&](size_t, const InsertStatement& insert) {
            auto yml_insert = inserts_node.append_child();
            yml_insert.set_type(c4::yml::MAP);
            if (insert.ast_statement_id) {
                yml_insert.append_child() << c4::yml::key("statement-id") << *insert.ast_statement_id;
            }
            yml_insert.append_child() << c4::yml::key("target-ref")
                                      << insert.target.get().table_reference_id.GetObject();
            if (insert.source_ast_node_id) {
                EncodeLocationText(yml_insert,
                                   script.parsed_script->scanned_script->ResolveTextSpan(
                                       script.parsed_script->nodes[*insert.source_ast_node_id].symbol_span()),
                                   script.parsed_script->scanned_script->GetInput(), "source");
            }
            if (insert.default_values) {
                yml_insert.append_child() << c4::yml::key("default-values") << c4::fmt::boolalpha(true);
            }
            if (insert.returning) {
                yml_insert.append_child() << c4::yml::key("returning") << c4::fmt::boolalpha(true);
            }
            if (!insert.target_columns.empty()) {
                auto columns = yml_insert.append_child();
                columns << c4::yml::key("columns");
                columns |= c4::yml::SEQ;
                for (auto& column : insert.target_columns) {
                    auto out_column = columns.append_child();
                    out_column.set_type(c4::yml::MAP);
                    out_column.append_child() << c4::yml::key("name")
                                              << std::string(column.column_name.get().text);
                    out_column.append_child() << c4::yml::key("resolved")
                                              << c4::fmt::boolalpha(column.resolved.has_value());
                }
            }
        });
    }

    // Write expressions
    if (!script.expressions.IsEmpty()) {
        auto expr_node = out.append_child();
        expr_node << c4::yml::key("expressions");
        expr_node |= c4::yml::SEQ;
        script.expressions.ForEach([&](size_t i, const AnalyzedScript::Expression& ref) {
            auto yml_ref = expr_node.append_child();
            yml_ref.set_type(c4::yml::MAP);
            yml_ref.append_child() << c4::yml::key("expression-idx") << i;
            std::visit(
                [&](const auto& value) {
                    using T = std::decay_t<decltype(value)>;
                    if constexpr (std::is_same_v<T, std::monostate>) {
                    } else if constexpr (std::is_same_v<T, AnalyzedScript::Expression::ColumnRef>) {
                        auto& column_ref = value;
                        if (!column_ref.IsResolved()) {
                            yml_ref.append_child() << c4::yml::key("type") << "colref/unresolved";
                        } else if (column_ref.IsResolved() && !column_ref.GetResolvedColumnIDs().has_value()) {
                            yml_ref.append_child() << c4::yml::key("type") << "colref/local";
                        } else {
                            auto resolved = *column_ref.GetResolvedColumnIDs();
                            auto [db_id, schema_id] = resolved.catalog_schema_id.UnpackSchemaID();
                            auto [table_id, column_idx] = resolved.catalog_table_column_id.UnpackTableColumnID();
                            std::string catalog_id =
                                std::format("{}.{}.{}.{}", db_id, schema_id, table_id.Pack(), column_idx);
                            auto type = (is_main && table_id.GetOrigin() == script.GetCatalogEntryId())
                                            ? "colref/internal"
                                            : "colref/catalog";
                            yml_ref.append_child() << c4::yml::key("type") << type;
                            auto cat_node = yml_ref.append_child();
                            cat_node << c4::yml::key("catalog") << catalog_id;
                            cat_node.set_val_style(c4::yml::VAL_DQUO);  // quote so YAML does not parse as float
                        }
                    } else if constexpr (std::is_same_v<T, AnalyzedScript::Expression::Literal>) {
                        auto& literal = value;
                        std::string type_name = "literal/";
                        switch (literal.literal_type) {
                            case dashql::buffers::algebra::LiteralType::NULL_:
                                type_name += "null";
                                break;
                            case dashql::buffers::algebra::LiteralType::INTERVAL:
                                type_name += "interval";
                                break;
                            case dashql::buffers::algebra::LiteralType::INTEGER:
                                type_name += "integer";
                                break;
                            case dashql::buffers::algebra::LiteralType::FLOAT:
                                type_name += "float";
                                break;
                            case dashql::buffers::algebra::LiteralType::STRING:
                                type_name += "string";
                                break;
                        }
                        yml_ref.append_child() << c4::yml::key("type") << type_name;
                    } else if constexpr (std::is_same_v<T, AnalyzedScript::Expression::Comparison>) {
                        auto& cmp = value;
                        yml_ref.append_child() << c4::yml::key("type") << "comparison";
                        yml_ref.append_child()
                            << c4::yml::key("op") << std::string(buffers::algebra::EnumNameComparisonFunction(cmp.func));
                        yml_ref.append_child() << c4::yml::key("arg-left") << cmp.left_expression_id;
                        yml_ref.append_child() << c4::yml::key("arg-right") << cmp.right_expression_id;
                    } else if constexpr (std::is_same_v<T, AnalyzedScript::Expression::BinaryExpression>) {
                        auto& binary = value;
                        yml_ref.append_child() << c4::yml::key("type") << "binary";
                        // The enum has gaps, so the name is looked up by value and not by type table index
                        yml_ref.append_child() << c4::yml::key("op")
                                               << std::string(buffers::algebra::EnumNameBinaryExpressionFunction(binary.func));
                        yml_ref.append_child() << c4::yml::key("arg-left") << binary.left_expression_id;
                        yml_ref.append_child() << c4::yml::key("arg-right") << binary.right_expression_id;
                    } else if constexpr (std::is_same_v<T, AnalyzedScript::Expression::FunctionCallExpression>) {
                        auto& func = value;
                        yml_ref.append_child() << c4::yml::key("type") << "function";
                        std::visit(
                            [&](const auto& func_name_value) {
                                using FuncT = std::decay_t<decltype(func_name_value)>;
                                if constexpr (std::is_same_v<FuncT, buffers::parser::KnownFunction>) {
                                    auto known = func_name_value;
                                    auto known_name =
                                        buffers::parser::KnownFunctionTypeTable()->names[static_cast<size_t>(known)];
                                    yml_ref.append_child() << c4::yml::key("known-function") << std::string(known_name);
                                } else if constexpr (std::is_same_v<FuncT, CatalogEntry::QualifiedFunctionName>) {
                                    yml_ref.append_child() << c4::yml::key("name") << func_name_value.getDebugString();
                                } else {
                                    static_assert(always_false<FuncT>,
                                                  "Unhandled function name type in analyzer snapshot test");
                                }
                            },
                            func.function_name);
                    } else if constexpr (std::is_same_v<T, AnalyzedScript::Expression::ConstIntervalCast>) {
                        yml_ref.append_child() << c4::yml::key("type") << "constcast/interval";
                    } else {
                        static_assert(always_false<T>, "Unhandled expression type in analyzer snapshot test");
                    }
                },
                ref.inner);
            if (ref.is_constant_expression) {
                yml_ref.append_child() << c4::yml::key("is-const") << c4::fmt::boolalpha(ref.is_constant_expression);
            }
            if (ref.ast_statement_id.has_value()) {
                yml_ref.append_child() << c4::yml::key("statement-id") << *ref.ast_statement_id;
            }
            EncodeLocationText(yml_ref,
                               script.parsed_script->scanned_script->ResolveTextSpan(
                                   script.parsed_script->nodes[ref.ast_node_id].symbol_span()),
                               script.parsed_script->scanned_script->GetInput());
        });
    }

    // Write constant expressions
    if (!script.constant_expressions.IsEmpty()) {
        auto list_node = out.append_child();
        list_node << c4::yml::key("constants");
        list_node |= c4::yml::SEQ;
        script.constant_expressions.ForEach([&](size_t _i, const AnalyzedScript::ConstantExpression& constant) {
            auto yml_ref = list_node.append_child();
            yml_ref.set_type(c4::yml::MAP);
            yml_ref.append_child() << c4::yml::key("expression") << constant.root.get().expression_id;
            EncodeLocationText(yml_ref,
                               script.parsed_script->scanned_script->ResolveTextSpan(
                                   script.parsed_script->nodes[constant.root.get().ast_node_id].symbol_span()),
                               script.parsed_script->scanned_script->GetInput());
        });
    }
    // Write visualization specs, including renderer-specific payloads.
    if (!script.visualization_specs.IsEmpty()) {
        auto list_node = out.append_child();
        list_node << c4::yml::key("visualizations");
        list_node |= c4::yml::SEQ;
        script.visualization_specs.ForEach([&](size_t _i, const AnalyzedScript::VisualizationSpec& spec) {
            auto yml_ref = list_node.append_child();
            yml_ref.set_type(c4::yml::MAP);
            if (spec.ast_statement_id.has_value()) {
                yml_ref.append_child() << c4::yml::key("statement-id") << *spec.ast_statement_id;
            }
            if (spec.source_node_id.has_value()) {
                EncodeLocationText(yml_ref,
                                   script.parsed_script->scanned_script->ResolveTextSpan(
                                       script.parsed_script->nodes[*spec.source_node_id].symbol_span()),
                                   script.parsed_script->scanned_script->GetInput(), "source");
            }
            if (spec.renderer.has_value()) {
                yml_ref.append_child() << c4::yml::key("renderer") << std::string(*spec.renderer);
            }
            auto dashboard_node = yml_ref.append_child();
            dashboard_node << c4::yml::key("dashboard");
            dashboard_node |= c4::yml::MAP;
            if (spec.dashboard.row) dashboard_node.append_child() << c4::yml::key("row") << *spec.dashboard.row;
            if (spec.dashboard.column)
                dashboard_node.append_child() << c4::yml::key("column") << *spec.dashboard.column;
            dashboard_node.append_child() << c4::yml::key("width") << spec.dashboard.width;
            dashboard_node.append_child() << c4::yml::key("height") << spec.dashboard.height;
            // The structured spec is renderer-specific and is emitted under a renderer-tagged
            // sub-map. Only `vegalite` is understood today; a future renderer adds its own block
            // rather than overloading these keys. Returns early for other/absent renderers.
            if (!spec.renderer.has_value() || *spec.renderer != "vegalite") return;
            auto vl_node = yml_ref.append_child();
            vl_node << c4::yml::key("vegalite");
            vl_node |= c4::yml::MAP;
            if (spec.mark_type.has_value()) {
                auto* tt = buffers::parser::VisMarkTypeTypeTable();
                vl_node.append_child()
                    << c4::yml::key("mark") << std::string(tt->names[static_cast<uint8_t>(*spec.mark_type)]);
            }
            if (spec.title.has_value())
                vl_node.append_child() << c4::yml::key("title") << std::string(*spec.title);
            if (!spec.layers.empty())
                vl_node.append_child() << c4::yml::key("layer-count") << spec.layers.size();
            if (spec.resolve.has_value()) {
                auto resolve_node = vl_node.append_child();
                resolve_node << c4::yml::key("resolve");
                resolve_node |= c4::yml::MAP;
                if (spec.resolve->scale_node_id.has_value())
                    resolve_node.append_child() << c4::yml::key("scale-node-id") << *spec.resolve->scale_node_id;
                if (spec.resolve->axis_node_id.has_value())
                    resolve_node.append_child() << c4::yml::key("axis-node-id") << *spec.resolve->axis_node_id;
                if (spec.resolve->legend_node_id.has_value())
                    resolve_node.append_child() << c4::yml::key("legend-node-id") << *spec.resolve->legend_node_id;
            }
            if (!spec.encoding_channels.empty()) {
                auto channels_node = vl_node.append_child();
                channels_node << c4::yml::key("encodings");
                channels_node |= c4::yml::SEQ;
                auto* key_tt = buffers::parser::AttributeKeyTypeTable();
                for (auto& channel : spec.encoding_channels) {
                    auto ch_node = channels_node.append_child();
                    ch_node.set_type(c4::yml::MAP);
                    ch_node.append_child()
                        << c4::yml::key("channel")
                        << std::string(key_tt->names[static_cast<uint16_t>(channel.channel_key)]);
                    if (channel.field_expression_id.has_value()) {
                        ch_node.append_child() << c4::yml::key("field-expr") << *channel.field_expression_id;
                    }
                    if (channel.field_node_id.has_value()) {
                        ch_node.append_child() << c4::yml::key("field-node-id") << *channel.field_node_id;
                    }
                    if (channel.field_type.has_value()) {
                        auto* ft_tt = buffers::parser::VisFieldTypeTypeTable();
                        ch_node.append_child()
                            << c4::yml::key("field-type")
                            << std::string(ft_tt->names[static_cast<uint8_t>(*channel.field_type)]);
                    }
                    if (channel.bin.has_value()) {
                        auto bin_node = ch_node.append_child();
                        bin_node << c4::yml::key("bin");
                        bin_node |= c4::yml::MAP;
                        auto& b = *channel.bin;
                        if (b.binned.has_value())
                            bin_node.append_child() << c4::yml::key("binned") << c4::fmt::boolalpha(*b.binned);
                        if (b.step.has_value())
                            bin_node.append_child() << c4::yml::key("step") << *b.step;
                        if (b.maxbins.has_value())
                            bin_node.append_child() << c4::yml::key("maxbins") << *b.maxbins;
                        if (b.minstep.has_value())
                            bin_node.append_child() << c4::yml::key("minstep") << *b.minstep;
                        if (b.anchor.has_value())
                            bin_node.append_child() << c4::yml::key("anchor") << *b.anchor;
                        if (b.base.has_value())
                            bin_node.append_child() << c4::yml::key("base") << *b.base;
                        if (b.nice.has_value())
                            bin_node.append_child() << c4::yml::key("nice") << c4::fmt::boolalpha(*b.nice);
                        if (b.extent_node_id.has_value())
                            bin_node.append_child() << c4::yml::key("extent-node-id") << *b.extent_node_id;
                        if (b.divide_node_id.has_value())
                            bin_node.append_child() << c4::yml::key("divide-node-id") << *b.divide_node_id;
                        if (b.steps_node_id.has_value())
                            bin_node.append_child() << c4::yml::key("steps-node-id") << *b.steps_node_id;
                    }
                    if (channel.aggregate.has_value()) {
                        ch_node.append_child() << c4::yml::key("aggregate") << std::string(*channel.aggregate);
                    }
                    if (channel.time_unit.has_value()) {
                        ch_node.append_child() << c4::yml::key("time-unit") << std::string(*channel.time_unit);
                    }
                    if (channel.stack_node_id.has_value()) {
                        ch_node.append_child() << c4::yml::key("stack-node-id") << *channel.stack_node_id;
                    }
                    if (channel.scale.has_value()) {
                        auto scale_node = ch_node.append_child();
                        scale_node << c4::yml::key("scale");
                        scale_node |= c4::yml::MAP;
                        auto& s = *channel.scale;
                        if (s.type.has_value()) {
                            auto* tt = buffers::parser::VisScaleTypeTypeTable();
                            scale_node.append_child()
                                << c4::yml::key("type")
                                << std::string(tt->names[static_cast<uint8_t>(*s.type)]);
                        }
                        if (s.zero.has_value())
                            scale_node.append_child() << c4::yml::key("zero") << c4::fmt::boolalpha(*s.zero);
                        if (s.nice.has_value())
                            scale_node.append_child() << c4::yml::key("nice") << c4::fmt::boolalpha(*s.nice);
                        if (s.clamp.has_value())
                            scale_node.append_child() << c4::yml::key("clamp") << c4::fmt::boolalpha(*s.clamp);
                        if (s.reverse.has_value())
                            scale_node.append_child()
                                << c4::yml::key("reverse") << c4::fmt::boolalpha(*s.reverse);
                        if (s.round.has_value())
                            scale_node.append_child() << c4::yml::key("round") << c4::fmt::boolalpha(*s.round);
                        if (s.scheme.has_value())
                            scale_node.append_child() << c4::yml::key("scheme") << std::string(*s.scheme);
                        if (s.interpolate.has_value())
                            scale_node.append_child()
                                << c4::yml::key("interpolate") << std::string(*s.interpolate);
                        if (s.exponent.has_value())
                            scale_node.append_child() << c4::yml::key("exponent") << *s.exponent;
                        if (s.base.has_value())
                            scale_node.append_child() << c4::yml::key("base") << *s.base;
                        if (s.constant.has_value())
                            scale_node.append_child() << c4::yml::key("constant") << *s.constant;
                        if (s.align.has_value())
                            scale_node.append_child() << c4::yml::key("align") << *s.align;
                        if (s.padding.has_value())
                            scale_node.append_child() << c4::yml::key("padding") << *s.padding;
                        if (s.padding_inner.has_value())
                            scale_node.append_child() << c4::yml::key("padding-inner") << *s.padding_inner;
                        if (s.padding_outer.has_value())
                            scale_node.append_child() << c4::yml::key("padding-outer") << *s.padding_outer;
                        if (s.domain_node_id.has_value())
                            scale_node.append_child() << c4::yml::key("domain-node-id") << *s.domain_node_id;
                        if (s.domain_min_node_id.has_value())
                            scale_node.append_child() << c4::yml::key("domain-min-node-id") << *s.domain_min_node_id;
                        if (s.domain_max_node_id.has_value())
                            scale_node.append_child() << c4::yml::key("domain-max-node-id") << *s.domain_max_node_id;
                        if (s.domain_mid_node_id.has_value())
                            scale_node.append_child() << c4::yml::key("domain-mid-node-id") << *s.domain_mid_node_id;
                        if (s.range_node_id.has_value())
                            scale_node.append_child() << c4::yml::key("range-node-id") << *s.range_node_id;
                        if (s.range_min_node_id.has_value())
                            scale_node.append_child() << c4::yml::key("range-min-node-id") << *s.range_min_node_id;
                        if (s.range_max_node_id.has_value())
                            scale_node.append_child() << c4::yml::key("range-max-node-id") << *s.range_max_node_id;
                        if (s.bins_node_id.has_value())
                            scale_node.append_child() << c4::yml::key("bins-node-id") << *s.bins_node_id;
                        if (s.name.has_value())
                            scale_node.append_child() << c4::yml::key("name") << std::string(*s.name);
                    }
                    if (channel.axis.has_value()) {
                        auto axis_node = ch_node.append_child();
                        axis_node << c4::yml::key("axis");
                        axis_node |= c4::yml::MAP;
                        auto& a = *channel.axis;
                        if (a.orient.has_value())
                            axis_node.append_child() << c4::yml::key("orient") << std::string(*a.orient);
                        if (a.title.has_value())
                            axis_node.append_child() << c4::yml::key("title") << std::string(*a.title);
                        if (a.grid.has_value())
                            axis_node.append_child() << c4::yml::key("grid") << c4::fmt::boolalpha(*a.grid);
                        if (a.ticks.has_value())
                            axis_node.append_child() << c4::yml::key("ticks") << c4::fmt::boolalpha(*a.ticks);
                        if (a.domain.has_value())
                            axis_node.append_child()
                                << c4::yml::key("domain") << c4::fmt::boolalpha(*a.domain);
                        if (a.label_angle.has_value())
                            axis_node.append_child() << c4::yml::key("label-angle") << *a.label_angle;
                        if (a.label_font_size.has_value())
                            axis_node.append_child() << c4::yml::key("label-font-size") << *a.label_font_size;
                        if (a.tick_count.has_value())
                            axis_node.append_child() << c4::yml::key("tick-count") << *a.tick_count;
                        if (a.tick_size.has_value())
                            axis_node.append_child() << c4::yml::key("tick-size") << *a.tick_size;
                        if (a.offset.has_value())
                            axis_node.append_child() << c4::yml::key("offset") << *a.offset;
                        if (a.format.has_value())
                            axis_node.append_child() << c4::yml::key("format") << std::string(*a.format);
                        if (a.format_type.has_value())
                            axis_node.append_child()
                                << c4::yml::key("format-type") << std::string(*a.format_type);
                        if (a.direction.has_value())
                            axis_node.append_child()
                                << c4::yml::key("direction") << std::string(*a.direction);
                        if (a.label_overlap.has_value())
                            axis_node.append_child()
                                << c4::yml::key("label-overlap") << std::string(*a.label_overlap);
                        if (a.zindex.has_value())
                            axis_node.append_child() << c4::yml::key("zindex") << *a.zindex;
                        if (a.values_node_id.has_value())
                            axis_node.append_child() << c4::yml::key("values-node-id") << *a.values_node_id;
                        if (a.name.has_value())
                            axis_node.append_child() << c4::yml::key("name") << std::string(*a.name);
                    }
                    if (channel.legend.has_value()) {
                        auto legend_node = ch_node.append_child();
                        legend_node << c4::yml::key("legend");
                        legend_node |= c4::yml::MAP;
                        auto& l = *channel.legend;
                        if (l.type.has_value())
                            legend_node.append_child() << c4::yml::key("type") << std::string(*l.type);
                        if (l.orient.has_value())
                            legend_node.append_child() << c4::yml::key("orient") << std::string(*l.orient);
                        if (l.title.has_value())
                            legend_node.append_child() << c4::yml::key("title") << std::string(*l.title);
                        if (l.direction.has_value())
                            legend_node.append_child()
                                << c4::yml::key("direction") << std::string(*l.direction);
                        if (l.format.has_value())
                            legend_node.append_child() << c4::yml::key("format") << std::string(*l.format);
                        if (l.format_type.has_value())
                            legend_node.append_child()
                                << c4::yml::key("format-type") << std::string(*l.format_type);
                        if (l.padding.has_value())
                            legend_node.append_child() << c4::yml::key("padding") << *l.padding;
                        if (l.offset.has_value())
                            legend_node.append_child() << c4::yml::key("offset") << *l.offset;
                        if (l.zindex.has_value())
                            legend_node.append_child() << c4::yml::key("zindex") << *l.zindex;
                        if (l.values_node_id.has_value())
                            legend_node.append_child() << c4::yml::key("values-node-id") << *l.values_node_id;
                        if (l.name.has_value())
                            legend_node.append_child() << c4::yml::key("name") << std::string(*l.name);
                    }
                }
            }
        });
    }

    // Write inferred table schemas (schema inference)
    if (!script.inferred_table_schemas.IsEmpty()) {
        auto confidence_str = [](InferenceConfidence c) -> const char* {
            switch (c) {
                case InferenceConfidence::CONFIDENT:
                    return "confident";
                case InferenceConfidence::CANDIDATE:
                    return "candidate";
                case InferenceConfidence::NONE:
                    return "none";
            }
            return "none";
        };
        auto list_node = out.append_child();
        list_node << c4::yml::key("inferred-tables");
        list_node |= c4::yml::SEQ;
        script.inferred_table_schemas.ForEach([&](size_t, const AnalyzedScript::InferredTableSchema& schema) {
            auto yml_schema = list_node.append_child();
            yml_schema.set_type(c4::yml::MAP);
            yml_schema.append_child() << c4::yml::key("name") << std::string(schema.table_name.getDebugString());
            yml_schema.append_child() << c4::yml::key("confidence") << confidence_str(schema.confidence);
            auto cols_node = yml_schema.append_child();
            cols_node << c4::yml::key("columns");
            cols_node |= c4::yml::SEQ;
            for (auto& col : schema.columns) {
                auto col_node = cols_node.append_child();
                col_node.set_type(c4::yml::MAP);
                col_node.append_child() << c4::yml::key("name") << std::string(col.column_name.get().text);
                col_node.append_child() << c4::yml::key("confidence") << confidence_str(col.confidence);
                if (!col.candidate_table_names.empty()) {
                    auto cand_node = col_node.append_child();
                    cand_node << c4::yml::key("candidates");
                    cand_node |= c4::yml::SEQ;
                    for (auto& cand : col.candidate_table_names) {
                        cand_node.append_child() << std::string(cand.getDebugString());
                    }
                }
            }
        });
    }
}

struct AnalyzerSnapshotFile {
    std::string content;
    c4::yml::Tree tree;
    std::vector<AnalyzerSnapshotTest> tests;
};
static std::unordered_map<std::string, AnalyzerSnapshotFile> TEST_FILES;

/// Get the grammar tests
void AnalyzerSnapshotTest::LoadTests(const std::filesystem::path& snapshots_dir) {
    if (!TEST_FILES.empty()) return;
    std::cout << "Loading analyzer tests at: " << snapshots_dir << std::endl;

    for (auto& p : std::filesystem::directory_iterator(snapshots_dir)) {
        auto filename = p.path().filename().string();
        if (p.path().extension().string() != ".yaml") continue;

        // Skip template outputs (e.g. basic.tpl.yaml)
        if (filename.find(".tpl.") != std::string::npos) continue;

        std::ifstream in(p.path(), std::ios::in | std::ios::binary);
        if (!in) {
            std::cout << "[ SETUP    ] failed to read test file: " << filename << std::endl;
            continue;
        }
        std::stringstream buf;
        buf << in.rdbuf();
        std::string content = buf.str();

        AnalyzerSnapshotFile file;
        file.content = std::move(content);
        c4::yml::parse_in_arena(c4::to_csubstr(file.content), &file.tree);

        auto root = file.tree.rootref();
        if (!root.has_child("analyzer-snapshots")) {
            std::cout << "[ SETUP    ] " << filename << ": no analyzer-snapshots key" << std::endl;
            continue;
        }
        auto snapshots = root["analyzer-snapshots"];
        for (auto test_node : snapshots.children()) {
            file.tests.emplace_back();
            auto& test = file.tests.back();
            if (test_node.has_child("name")) {
                c4::csubstr v = test_node["name"].val();
                test.name = v.str ? std::string(v.str, v.len) : std::string();
            }
            if (test_node.has_child("script")) {
                auto script_node = test_node["script"];
                test.script.ReadFrom(script_node);
                test.script.tree = &file.tree;
                test.script.node_id = script_node.id();
            }
            if (test_node.has_child("catalog") && test_node["catalog"].has_child("script")) {
                auto script_node = test_node["catalog"]["script"];
                test.catalog_entries.emplace_back();
                auto& entry = test.catalog_entries.back();
                entry.ReadFrom(script_node);
                entry.tree = &file.tree;
                entry.node_id = script_node.id();
            }
        }

        std::cout << "[ SETUP    ] " << filename << ": " << file.tests.size() << " tests" << std::endl;
        auto it = TEST_FILES.insert({filename, std::move(file)}).first;
        for (auto& t : it->second.tests) {
            t.script.tree = &it->second.tree;
            for (auto& e : t.catalog_entries) e.tree = &it->second.tree;
        }
    }
}

// Get the tests
std::vector<const AnalyzerSnapshotTest*> AnalyzerSnapshotTest::GetTests(std::string_view filename) {
    if (TEST_FILES.empty()) {
        auto root = GetRunfilesSnapshotRoot();
        LoadTests((root.empty() ? std::filesystem::path(".") : root) / "snapshots" / "analyzer");
    }
    std::string name{filename};
    auto iter = TEST_FILES.find(name);
    if (iter == TEST_FILES.end()) {
        return {};
    }
    std::vector<const AnalyzerSnapshotTest*> tests;
    for (auto& test : iter->second.tests) {
        tests.emplace_back(&test);
    }
    return tests;
}

}  // namespace testing
}  // namespace dashql
