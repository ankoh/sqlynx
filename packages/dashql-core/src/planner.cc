#include "dashql/planner.h"

#include <algorithm>
#include <cctype>
#include <exception>
#include <map>
#include <set>
#include <tuple>

#include "dashql/script_compiler.h"
#include "dashql/utils/ast_attributes.h"

namespace dashql {

buffers::execution::ExecutionGraphT Planner::Plan(std::span<const PlannerInput> inputs) {
    using namespace buffers::execution;
    using Type = buffers::parser::StatementType;
    using Key = buffers::parser::AttributeKey;
    using NodeType = buffers::parser::NodeType;
    using Mode = ExecutionGraphAccessMode;
    using Reason = ExecutionGraphEdgeReason;
    using Name = std::tuple<std::string, std::string, std::string>;
    using Table = CatalogEntry::TableDeclaration;
    static_assert(static_cast<uint8_t>(ExecutionGraphEntityType::TABLE) == CatalogObjectType::TableDeclaration);
    constexpr uint32_t none = std::numeric_limits<uint32_t>::max();
    ExecutionGraphT graph;
    auto diagnose = [&](uint32_t node, std::string message, bool invalid = true) {
        auto diagnostic = std::make_unique<ExecutionGraphDiagnosticT>();
        diagnostic->node = node;
        diagnostic->message = std::move(message);
        graph.diagnostics.push_back(std::move(diagnostic));
        if (invalid) graph.valid = false;
    };
    Catalog* catalog = nullptr;
    std::set<CatalogEntryID> script_ids;
    std::vector<uint32_t> offsets;
    uint32_t count = 0;
    for (auto& input : inputs) {
        offsets.push_back(count);
        if (!input.script) {
            diagnose(none, "null planner script");
            continue;
        }
        auto& script = *input.script;
        if (!catalog) catalog = &script.GetCatalog();
        if (catalog != &script.GetCatalog()) diagnose(none, "planner scripts belong to different catalogs");
        if (!script_ids.insert(script.GetCatalogEntryId()).second) diagnose(none, "duplicate planner script");
        auto& scanned = script.GetScannedScript();
        auto& parsed = script.GetParsedScript();
        auto& analyzed = script.GetAnalyzedScript();
        if (!scanned || !parsed || !analyzed || analyzed->parsed_script != parsed ||
            parsed->scanned_script != scanned || scanned->text_version != script.text_version) {
            diagnose(none, "missing or stale script analysis");
            continue;
        }
        if (analyzed->GetCatalogVersion() != script.GetCatalog().GetVersion()) {
            diagnose(none, "stale catalog analysis");
            continue;
        }
        for (auto& error : scanned->errors) diagnose(none, "scanner: " + error.second);
        for (auto& error : parsed->errors) diagnose(none, "parser: " + error.message);
        if (parsed->statements.empty()) {
            auto text = scanned->GetInput();
            for (size_t offset = 0; offset < text.size(); ++offset) {
                auto comment = std::find_if(scanned->comments.begin(), scanned->comments.end(), [&](auto span) {
                    return span.offset() <= offset && offset < span.offset() + span.length();
                });
                if (comment != scanned->comments.end()) {
                    offset = comment->offset() + comment->length() - 1;
                } else if (std::string_view{" \t\r\n\f;"}.find(text[offset]) == std::string_view::npos) {
                    diagnose(none, "unsupported SQL: parser produced no statements");
                    break;
                }
            }
        }
        auto metadata = std::make_unique<ExecutionGraphScriptT>();
        metadata->script_id = script.GetCatalogEntryId();
        metadata->text_version = script.text_version;
        metadata->analyzed_text_version = analyzed->parsed_script->scanned_script->text_version;
        metadata->analyzed_catalog_revision = analyzed->GetCatalogVersion();
        graph.scripts.push_back(std::move(metadata));
        count += parsed->statements.size();
    }
    // Invalid input snapshots must never yield executable partial plans.
    if (!graph.valid) return graph;

    auto resource_name = [](const QualifiedTableName& name) -> Name {
        return {std::string(name.database_name.get().text), std::string(name.schema_name.get().text),
                std::string(name.table_name.get().text)};
    };
    std::map<uint64_t, uint32_t> producers;
    std::map<QualifiedCatalogObjectID, const Table*> declarations;
    std::map<QualifiedCatalogObjectID, bool> published_views;
    std::set<QualifiedCatalogObjectID> incompatible_kinds;
    std::set<uint64_t> views;
    auto remember_views = [&](const AnalyzedScript& analyzed) {
        analyzed.GetTables().ForEach([&](size_t, const CatalogEntry::TableDeclaration& table) {
            if (table.ast_statement_id &&
                analyzed.parsed_script->statements[*table.ast_statement_id].type == Type::CREATE_VIEW) {
                views.insert(table.GetTableID().Pack());
            }
        });
    };
    if (catalog) catalog->Iterate([&](auto, const CatalogEntry& entry) {
        if (auto* analyzed = dynamic_cast<const AnalyzedScript*>(&entry)) remember_views(*analyzed);
        entry.GetTables().ForEach([&](size_t, const Table& table) {
            declarations[table.object_id] = &table;
            published_views[table.object_id] = views.contains(table.GetTableID().Pack());
        });
    });
    for (size_t i = 0; i < inputs.size(); ++i) {
        auto& analyzed = *inputs[i].script->GetAnalyzedScript();
        remember_views(analyzed);
        analyzed.GetTables().ForEach([&](size_t, const CatalogEntry::TableDeclaration& table) {
            bool is_view = table.ast_statement_id &&
                           analyzed.parsed_script->statements[*table.ast_statement_id].type == Type::CREATE_VIEW;
            if (auto published = published_views.find(table.object_id);
                published != published_views.end() && published->second != is_view) {
                incompatible_kinds.insert(table.object_id);
            }
            declarations[table.object_id] = &table;
            if (table.ast_statement_id) producers[table.GetTableID().Pack()] = offsets[i] + *table.ast_statement_id;
        });
    }

    std::map<QualifiedCatalogObjectID, uint32_t> entities;
    std::map<Name, uint32_t> unresolved_references;
    std::set<Name> live_producers;
    std::set<Name> dropped_resources;
    std::set<Name> live_views;
    std::map<Name, const Table*> live_namespace;
    if (catalog) catalog->IterateRanked([&](auto entry_id, const CatalogEntry& entry, auto) {
        // Participating declarations enter the namespace only when their CREATE is reached.
        if (script_ids.contains(entry_id)) return;
        entry.GetTables().ForEach([&](size_t, const CatalogEntry::TableDeclaration& table) {
            live_namespace.emplace(resource_name(table.table_name), &table);
        });
    });
    auto intern_entity = [&](const Table& table) {
        auto [it, inserted] = entities.emplace(table.object_id, graph.entities.size());
        if (inserted) {
            auto entity = std::make_unique<ExecutionGraphEntityT>();
            entity->catalog_object_id = std::make_unique<ExecutionGraphCatalogObjectID>(
                ExecutionGraphEntityType::TABLE, table.object_id.UnpackTableID().Pack(), 0);
            std::tie(entity->catalog_database_id, entity->catalog_schema_id) = table.catalog_schema_id.UnpackSchemaID();
            std::tie(entity->database_name, entity->schema_name, entity->name) = resource_name(table.table_name);
            graph.entities.push_back(std::move(entity));
        }
        return it->second;
    };
    auto intern_unresolved = [&](const Name& name) {
        auto [it, inserted] = unresolved_references.emplace(name, graph.unresolved_references.size());
        if (inserted) {
            auto ref = std::make_unique<ExecutionGraphUnresolvedReferenceT>();
            std::tie(ref->database_name, ref->schema_name, ref->name) = name;
            graph.unresolved_references.push_back(std::move(ref));
        }
        return it->second;
    };
    for (size_t si = 0; si < inputs.size(); ++si) {
        auto& script = *inputs[si].script;
        auto& analyzed = *script.GetAnalyzedScript();
        auto& parsed = *script.GetParsedScript();
        auto descriptions = parsed.AssociateDescriptions();
        for (size_t statement_id = 0; statement_id < parsed.statements.size(); ++statement_id) {
            uint32_t node_id = graph.nodes.size();
            auto node = std::make_unique<ExecutionGraphNodeT>();
            node->script = si;
            node->statement_id = statement_id;
            node->statement_type = parsed.statements[statement_id].type;
            auto type = node->statement_type;
            node->sql = parsed.scanned_script->ReadTextAtTextSpan(descriptions[statement_id].statement_span);
            node->produces_output = type == Type::SELECT || type == Type::EXPLAIN || type == Type::VIS_VISUALISE;
            auto& statement = parsed.statements[statement_id];
            auto& root = parsed.nodes[statement.root];
            auto children = [&](const buffers::parser::Node& ast) {
                return std::span<const buffers::parser::Node>{parsed.nodes}.subspan(ast.children_begin_or_value(),
                                                                                  ast.children_count());
            };
            bool explain_executes = false;
            std::map<std::pair<uint32_t, uint32_t>, Mode> accesses;
            auto access = [&](const Name& name, const Table* table, Mode mode) {
                auto target = table ? std::pair{intern_entity(*table), none}
                                    : std::pair{none, intern_unresolved(name)};
                auto [it, inserted] = accesses.emplace(target, mode);
                if (!inserted && mode > it->second) it->second = mode;
            };
            auto barrier = [&](std::string message, bool invalid = false) {
                node->barrier = true;
                diagnose(node_id, std::move(message), invalid);
            };
            switch (type) {
                case Type::SELECT:
                case Type::INSERT:
                case Type::DELETE:
                case Type::EXPLAIN:
                case Type::VIS_VISUALISE:
                case Type::CREATE_TABLE:
                case Type::CREATE_TABLE_AS:
                case Type::CREATE_VIEW:
                case Type::SELECT_INTO:
                case Type::DROP_TABLE:
                case Type::DROP_VIEW:
                    break;
                default:
                    barrier("unsupported statement effects; backend session semantics are not guaranteed", true);
                    node->sql.clear();
                    break;
            }
            if (type == Type::VIS_VISUALISE) {
                auto [source] = LookupAttributes<Key::VIS_VISUALISE_SELECT>(children(root));
                if (!source || source->node_type() != NodeType::OBJECT_SQL_SELECT) {
                    barrier("VISUALIZE requires a SELECT source", true);
                    node->sql.clear();
                } else {
                    node->sql = parsed.scanned_script->ReadTextAtSymbolSpan(source->symbol_span());
                    const VisualizationSpec* visualization = nullptr;
                    analyzed.visualization_specs.ForEach([&](size_t, const VisualizationSpec& spec) {
                        if (!visualization && spec.ast_statement_id == statement_id) visualization = &spec;
                    });
                    if (!visualization) {
                        barrier("could not resolve visualization metadata", true);
                        node->sql.clear();
                    } else {
                        try {
                            node->visualization = std::make_unique<CompiledVisualizationT>(
                                ScriptCompiler::CompileVisualization(*visualization, analyzed).ToObject());
                        } catch (const std::exception& error) {
                            barrier(std::string{"visualization: "} + error.what(), true);
                            node->sql.clear();
                        }
                    }
                }
            }
            if (type == Type::EXPLAIN) {
                auto [body, options] =
                    LookupAttributes<Key::EXT_EXPLAIN_STATEMENT, Key::EXT_EXPLAIN_OPTIONS>(children(root));
                auto option_text = [&](const buffers::parser::Node* ast) {
                    std::string text;
                    if (ast && ast->node_type() != NodeType::NONE) {
                        text = parsed.scanned_script->ReadTextAtSymbolSpan(ast->symbol_span());
                        std::transform(text.begin(), text.end(), text.begin(),
                                       [](unsigned char c) { return std::tolower(c); });
                        if (text.size() >= 2 && (text.front() == '\'' || text.front() == '"') &&
                            text.back() == text.front()) text = text.substr(1, text.size() - 2);
                    }
                    return text;
                };
                if (options && options->node_type() == NodeType::ARRAY) {
                    for (auto& option : children(*options)) {
                        if (option.node_type() != NodeType::OBJECT_SQL_GENERIC_OPTION) continue;
                        auto [key, value] =
                            LookupAttributes<Key::SQL_GENERIC_OPTION_KEY, Key::SQL_GENERIC_OPTION_VALUE>(children(option));
                        auto name = option_text(key);
                        if (name == "analyze" || name == "analyse") {
                            // Unknown arguments are execution-enabled, not proof of read-only behavior.
                            explain_executes |= !value || value->node_type() != NodeType::BOOL ||
                                                value->children_begin_or_value() != 0;
                        } else if (name == "format" &&
                                   (option_text(value) == "analyze" || option_text(value) == "analyse")) {
                            explain_executes = true;
                        }
                    }
                }
                if (!body || body->node_type() == NodeType::NONE) {
                    barrier("EXPLAIN requires a statement or expressions body", true);
                    node->sql.clear();
                }
            }
            for (auto& error : analyzed.errors) {
                if (error.ast_node_id < statement.nodes_begin ||
                    error.ast_node_id >= statement.nodes_begin + statement.node_count) continue;
                bool invalid = error.severity == buffers::analyzer::AnalyzerErrorSeverity::ERROR;
                diagnose(node_id, "analyzer: " + error.message, invalid);
                if (invalid) node->barrier = true;
            }
            if (type == Type::INSERT || type == Type::DELETE) {
                auto [returning] = type == Type::INSERT ? LookupAttributes<Key::SQL_INSERT_RETURNING>(children(root))
                                                        : LookupAttributes<Key::SQL_DELETE_RETURNING>(children(root));
                node->produces_output = returning && returning->node_type() != NodeType::NONE;
            }
            // These AST effects are not represented by ordinary relation reads.
            for (size_t ni = statement.nodes_begin; ni < statement.nodes_begin + statement.node_count; ++ni) {
                auto& ast = parsed.nodes[ni];
                if (ast.node_type() == NodeType::NONE) continue;
                bool mutating = ast.node_type() == NodeType::OBJECT_SQL_INSERT ||
                                ast.node_type() == NodeType::OBJECT_SQL_DELETE ||
                                ast.node_type() == NodeType::OBJECT_SQL_CREATE ||
                                ast.node_type() == NodeType::OBJECT_SQL_CREATE_AS ||
                                ast.node_type() == NodeType::OBJECT_SQL_VIEW ||
                                ast.node_type() == NodeType::OBJECT_SQL_CREATE_FUNCTION ||
                                ast.attribute_key() == Key::SQL_SELECT_INTO;
                if (type == Type::EXPLAIN && explain_executes && mutating) {
                    barrier("execution-enabled EXPLAIN with a mutating body cannot be safely classified", true);
                    node->sql.clear();
                }
                if (type == Type::VIS_VISUALISE && ast.attribute_key() == Key::SQL_SELECT_INTO) {
                    barrier("VISUALIZE SELECT INTO has unsupported mutation and session effects", true);
                    node->sql.clear();
                }
                if (ast.node_type() == NodeType::ENUM_SQL_TEMP_TYPE &&
                    ast.children_begin_or_value() == static_cast<uint32_t>(buffers::parser::TempType::NONE)) continue;
                if (ast.attribute_key() == Key::SQL_CREATE_TABLE_TEMP ||
                    ast.attribute_key() == Key::SQL_CREATE_AS_TEMP || ast.attribute_key() == Key::SQL_VIEW_TEMP ||
                    ast.attribute_key() == Key::SQL_TEMP_TYPE || ast.attribute_key() == Key::SQL_SELECT_ROW_LOCKING ||
                    ast.attribute_key() == Key::SQL_TABLE_CONSTRAINT_REFERENCES_NAME ||
                    ast.node_type() == NodeType::OBJECT_SQL_GRAPH_TABLE ||
                    ast.node_type() == NodeType::OBJECT_SQL_PROPERTY_GRAPH) {
                    barrier("unsupported session, locking, constraint, or graph effects", true);
                }
            }
            analyzed.table_references.ForEach([&](size_t, const TableReference& ref) {
                if (ref.ast_statement_id != statement_id) return;
                auto* relation = std::get_if<TableReference::RelationExpression>(&ref.inner);
                if (!relation) {
                    barrier("unsupported table source", true);
                    return;
                }
                if (!relation->resolved_alternatives.empty()) barrier("ambiguous relation reference", true);
                if (!relation->resolved_table && ref.role == TableReference::Role::Read && ref.ast_scope_root &&
                    relation->table_name.database_name.get().text.empty() &&
                    relation->table_name.schema_name.get().text.empty()) {
                    auto scope = analyzed.name_scopes_by_root_node.find(*ref.ast_scope_root);
                    if (scope != analyzed.name_scopes_by_root_node.end()) {
                        auto alias = ref.alias ? ref.alias->first.get().text : relation->table_name.table_name.get().text;
                        auto binding = scope->second.get().referenced_tables_by_name.find(alias);
                        if (binding != scope->second.get().referenced_tables_by_name.end() &&
                            std::holds_alternative<std::reference_wrapper<ResolvedCTE>>(binding->second.source)) return;
                    }
                }
                auto name = resource_name(relation->resolved_table ? relation->resolved_table->table_name
                                                                  : relation->table_name);
                const Table* table = nullptr;
                if (relation->resolved_table) {
                    auto declaration = declarations.find(relation->resolved_table->catalog_table_id);
                    if (declaration != declarations.end() &&
                        declaration->second->catalog_schema_id == relation->resolved_table->catalog_schema_id &&
                        resource_name(declaration->second->table_name) == name &&
                        !incompatible_kinds.contains(declaration->first)) {
                        table = declaration->second;
                    }
                    // Analysis can bind an earlier access to a later same-name declaration.
                    // The live lifetime still owns that access, not the future CREATE.
                    if (auto live = live_namespace.find(name); table && live != live_namespace.end() &&
                        (live_producers.contains(name) ||
                         producers.contains(relation->resolved_table->catalog_table_id.UnpackTableID().Pack()))) {
                        table = live->second;
                    }
                    if (!table) barrier("resolved relation declaration is incompatible or unavailable", true);
                }
                bool write = ref.role == TableReference::Role::Write && (type != Type::EXPLAIN || explain_executes);
                access(name, table, write ? Mode::WRITE : Mode::READ);
                if (dropped_resources.contains(name)) {
                    barrier("relation was dropped without an earlier lifetime producer; "
                            "later producer cannot be reordered", true);
                }
                if (!relation->resolved_table) {
                    barrier("unresolved relation: " + relation->table_name.getDebugString());
                } else {
                    auto id = table ? table->GetTableID().Pack()
                                    : relation->resolved_table->catalog_table_id.UnpackTableID().Pack();
                    auto producer = producers.find(id);
                    if (producer != producers.end() && producer->second >= node_id && !live_producers.contains(name)) {
                        barrier("relation resolves to a later producer in input order", true);
                    }
                    if (views.contains(id) || live_views.contains(name)) {
                        barrier("view dependencies are not expanded; conservative access barrier");
                    }
                }
            });
            auto packed = parsed.PackStatement(statement_id);
            bool drop = type == Type::DROP_TABLE || type == Type::DROP_VIEW;
            bool ddl = drop || type == Type::CREATE_TABLE || type == Type::CREATE_TABLE_AS ||
                       type == Type::CREATE_VIEW || type == Type::SELECT_INTO;
            if (ddl) {
                if (!packed->target) {
                    barrier("missing DDL target", true);
                } else {
                    auto& target = *packed->target;
                    Name name{target.database_name, target.schema_name, target.relation_name};
                    const Table* table = nullptr;
                    if (drop) {
                        // Prefer an exact live name, then native suffix matches. Never let a
                        // future declaration in an analyzed input redirect this DROP.
                        if (!live_namespace.contains(name)) {
                            std::set<Name> matches;
                            for (auto& [candidate, declaration] : live_namespace) {
                                if (std::get<2>(candidate) == target.relation_name &&
                                    (target.schema_name.empty() || std::get<1>(candidate) == target.schema_name) &&
                                    (target.database_name.empty() || std::get<0>(candidate) == target.database_name)) {
                                    matches.insert(candidate);
                                }
                            }
                            if (matches.size() == 1) name = *matches.begin();
                            else if (matches.size() > 1) barrier("ambiguous DROP target", true);
                        }
                        if (auto live = live_namespace.find(name); live != live_namespace.end()) table = live->second;
                        else barrier("unresolved DROP target; conservative access barrier");
                        if (table && (views.contains(table->GetTableID().Pack()) || live_views.contains(name))) {
                            barrier("view dependencies are not expanded; conservative access barrier");
                        }
                    } else {
                        analyzed.GetTables().ForEach([&](size_t, const Table& declaration) {
                            if (declaration.ast_statement_id == statement_id &&
                                resource_name(declaration.table_name) == name) table = &declaration;
                        });
                        if (table) name = resource_name(table->table_name);
                        else barrier("missing DDL target declaration", true);
                    }
                    access(name, table, Mode::DDL);
                    if (drop) {
                        live_producers.erase(name);
                        live_namespace.erase(name);
                        live_views.erase(name);
                        dropped_resources.insert(name);
                    } else {
                        live_producers.insert(name);
                        if (table) live_namespace[name] = table;
                        dropped_resources.erase(name);
                        if (type == Type::CREATE_VIEW) live_views.insert(name);
                        else live_views.erase(name);
                    }
                }
            }
            for (auto [target, mode] : accesses) {
                auto entry = std::make_unique<ExecutionGraphAccessT>();
                std::tie(entry->entity, entry->unresolved_reference) = target;
                entry->mode = mode;
                node->accesses.push_back(std::move(entry));
            }
            graph.nodes.push_back(std::move(node));
        }
    }

    struct Timeline {
        uint32_t writer = none;
        Mode mode = Mode::READ;
        std::vector<uint32_t> readers;
    };
    std::map<Name, Timeline> timelines;
    std::set<std::tuple<uint32_t, uint32_t, uint32_t, uint32_t, Reason>> edges;
    auto edge = [&](uint32_t from, uint32_t to, uint32_t entity, uint32_t unresolved, Reason reason) {
        if (from != none && from != to) edges.emplace(from, to, entity, unresolved, reason);
    };
    uint32_t last_barrier = none;
    std::vector<uint32_t> since_barrier;
    for (uint32_t i = 0; i < graph.nodes.size(); ++i) {
        auto& node = *graph.nodes[i];
        edge(last_barrier, i, none, none, Reason::BARRIER);
        if (node.barrier) {
            for (auto earlier : since_barrier) edge(earlier, i, none, none, Reason::BARRIER);
            since_barrier.clear();
            last_barrier = i;
        } else {
            since_barrier.push_back(i);
        }
        // Merge by name only for conflict tracking, retaining every published identity access.
        std::map<Name, const ExecutionGraphAccessT*> merged;
        for (auto& access : node.accesses) {
            Name name;
            if (access->entity != none) {
                auto& entity = *graph.entities[access->entity];
                name = {entity.database_name, entity.schema_name, entity.name};
            } else {
                auto& ref = *graph.unresolved_references[access->unresolved_reference];
                name = {ref.database_name, ref.schema_name, ref.name};
            }
            auto [it, inserted] = merged.emplace(name, access.get());
            if (!inserted && access->mode > it->second->mode) it->second = access.get();
        }
        for (auto& [name, access] : merged) {
            auto& timeline = timelines[name];
            bool ddl = access->mode == Mode::DDL || timeline.mode == Mode::DDL;
            if (access->mode == Mode::READ) {
                edge(timeline.writer, i, access->entity, access->unresolved_reference,
                     ddl ? Reason::DDL : Reason::READ_AFTER_WRITE);
                timeline.readers.push_back(i);
            } else {
                edge(timeline.writer, i, access->entity, access->unresolved_reference,
                     ddl ? Reason::DDL : Reason::WRITE_AFTER_WRITE);
                for (auto reader : timeline.readers) {
                    edge(reader, i, access->entity, access->unresolved_reference,
                         access->mode == Mode::DDL ? Reason::DDL : Reason::WRITE_AFTER_READ);
                }
                timeline.readers.clear();
                timeline.writer = i;
                timeline.mode = access->mode;
            }
        }
    }
    for (auto [from, to, entity, unresolved, reason] : edges) {
        auto entry = std::make_unique<ExecutionGraphEdgeT>();
        entry->from = from;
        entry->to = to;
        entry->entity = entity;
        entry->unresolved_reference = unresolved;
        entry->reason = reason;
        graph.edges.push_back(std::move(entry));
    }
    return graph;
}

}  // namespace dashql
