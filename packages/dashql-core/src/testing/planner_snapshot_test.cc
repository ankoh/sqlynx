#include "dashql/testing/planner_snapshot_test.h"

#include <algorithm>
#include <format>
#include <fstream>
#include <limits>
#include <set>
#include <sstream>
#include <stdexcept>
#include <unordered_map>

#include "c4/format.hpp"
#include "c4/yml/std/std.hpp"
#include "dashql/parser/grammar/keywords.h"
#include "dashql/planner.h"
#include "dashql/testing/runfiles_dir.h"
#include "dashql/testing/yaml_tests.h"
#include "dashql/utils/string_conversion.h"
#include "dashql/utils/string_trimming.h"

namespace dashql::testing {

void PlannerSnapshotTest::Encode(c4::yml::NodeRef out, c4::yml::ConstNodeRef fixture) {
    auto read = [](c4::yml::ConstNodeRef node) {
        auto value = node.val();
        return value.str ? std::string(value.str, value.len) : std::string{};
    };
    auto sql = [&](c4::yml::ConstNodeRef node) {
        auto text = read(node);
        return std::string(trim_view_right(trim_view_left(text, is_no_space), is_no_newline));
    };
    Catalog catalog;
    std::vector<std::unique_ptr<Script>> scripts;
    std::unique_ptr<Script> catalog_script;
    auto prepare = [&](std::string text) {
        auto script = std::make_unique<Script>(catalog);
        script->ReplaceText(text);
        script->Scan();
        script->Parse();
        script->Analyze(false);
        return script;
    };
    auto publishable = [](const Script& script) {
        return script.scanned_script->errors.empty() && script.parsed_script->errors.empty() &&
               std::none_of(script.analyzed_script->errors.begin(), script.analyzed_script->errors.end(),
                            [](const auto& error) {
                                return error.severity == buffers::analyzer::AnalyzerErrorSeverity::ERROR;
                            });
    };
    if (fixture.has_child("catalog")) {
        catalog_script = prepare(sql(fixture["catalog"]));
        if (!publishable(*catalog_script)) throw std::runtime_error("invalid planner fixture catalog");
        catalog.LoadScript(*catalog_script, 0);
    }
    std::vector<std::string> names;
    std::vector<PlannerInput> inputs;
    std::set<std::string> unique_names;
    for (auto source : fixture["scripts"].children()) {
        auto name = read(source["name"]);
        if (name.empty() || !unique_names.insert(name).second) {
            throw std::runtime_error("planner fixture script names must be nonempty and unique");
        }
        names.push_back(std::move(name));
        scripts.push_back(prepare(sql(source["input"])));
        inputs.push_back({scripts.back().get()});
    }
    // Publish the complete definition set before resolving any cross-script references.
    std::vector<Catalog::ScriptBatchEntry> definitions;
    for (size_t i = 0; i < scripts.size(); ++i) {
        if (publishable(*scripts[i]) && scripts[i]->analyzed_script->GetTables().GetSize() > 0) {
            definitions.push_back({scripts[i].get(), static_cast<CatalogEntry::Rank>(i + 1)});
        }
    }
    catalog.LoadScripts(definitions);
    for (auto& script : scripts) script->Analyze(false);
    size_t i = 0;
    for (auto source : fixture["scripts"].children()) {
        if (source.has_child("stale-prepend")) {
            scripts[i]->InsertTextAt(0, read(source["stale-prepend"]));
        }
        ++i;
    }
    auto graph = Planner::Plan(inputs);
    out |= c4::yml::MAP;
    out.append_child() << c4::yml::key("valid") << c4::fmt::boolalpha(graph.valid);
    auto sequence = [](c4::yml::NodeRef parent, const char* key) {
        auto node = parent.append_child();
        node << c4::yml::key(key);
        node |= c4::yml::SEQ;
        node.set_container_style(c4::yml::FLOW_SL);
        return node;
    };
    auto metadata = sequence(out, "scripts");
    if (!graph.scripts.empty()) metadata.set_container_style(c4::yml::BLOCK);
    for (auto& script : graph.scripts) {
        auto node = metadata.append_child();
        node |= c4::yml::MAP;
        auto found = std::find_if(inputs.begin(), inputs.end(), [&](const auto& input) {
            return input.script->GetCatalogEntryId() == script->script_id;
        });
        node.append_child() << c4::yml::key("name") << names.at(found - inputs.begin());
        node.append_child() << c4::yml::key("text-version") << script->text_version;
        node.append_child() << c4::yml::key("analyzed-text-version") << script->analyzed_text_version;
        node.append_child() << c4::yml::key("analyzed-catalog-revision") << script->analyzed_catalog_revision;
    }
    auto qualified_name = [](const auto& value) {
        std::string name;
        for (auto& component : {value.database_name, value.schema_name, value.name}) {
            if (component.empty()) continue;
            if (!name.empty()) name += '.';
            std::string quoted;
            if (parser::Keyword::Find(component) != nullptr && !identifier_requires_quotes(component)) {
                name += '"';
                name += component;
                name += '"';
            } else {
                name += quote_anyupper_fuzzy(component, quoted);
            }
        }
        return name;
    };
    auto catalog_id = [&](uint32_t index) {
        auto& value = *graph.entities.at(index);
        if (!value.catalog_object_id) throw std::runtime_error("planner entity requires a catalog object ID");
        auto& id = *value.catalog_object_id;
        using Type = buffers::execution::ExecutionGraphEntityType;
        std::string text;
        switch (id.object_type()) {
            case Type::DATABASE:
                text = std::to_string(id.object_id());
                break;
            case Type::SCHEMA:
                text = std::format("{}.{}", id.object_id(), id.sub_object_id());
                break;
            default:
                text = std::format("{}.{}.{}", value.catalog_database_id, value.catalog_schema_id, id.object_id());
                if (id.object_type() == Type::COLUMN || id.sub_object_id() != 0) {
                    text += '.' + std::to_string(id.sub_object_id());
                }
                break;
        }
        // Non-table categories need a discriminator even when their numeric IDs coincide.
        if (id.object_type() != Type::TABLE) {
            text = std::string(buffers::execution::EnumNameExecutionGraphEntityType(id.object_type())) + ':' + text;
        }
        return text;
    };
    auto quoted_id = [&](c4::yml::NodeRef parent, const char* key, uint32_t index) {
        auto node = parent.append_child();
        node << c4::yml::key(key) << catalog_id(index);
        node.set_val_style(c4::yml::VAL_SQUO);
    };
    auto entities = sequence(out, "entities");
    if (!graph.entities.empty()) entities.set_container_style(c4::yml::BLOCK);
    for (size_t ei = 0; ei < graph.entities.size(); ++ei) {
        auto& value = *graph.entities[ei];
        auto node = entities.append_child();
        node |= c4::yml::MAP;
        node.set_container_style(c4::yml::BLOCK);
        quoted_id(node, "catalog-id", ei);
        node.append_child() << c4::yml::key("type")
                            << buffers::execution::EnumNameExecutionGraphEntityType(value.catalog_object_id->object_type());
        node.append_child() << c4::yml::key("name") << qualified_name(value);
    }
    auto unresolved = sequence(out, "unresolved-references");
    if (!graph.unresolved_references.empty()) unresolved.set_container_style(c4::yml::BLOCK);
    for (auto& value : graph.unresolved_references) {
        auto node = unresolved.append_child();
        node |= c4::yml::MAP;
        node.set_container_style(c4::yml::BLOCK);
        node.append_child() << c4::yml::key("name") << qualified_name(*value);
    }
    auto target = [&](c4::yml::NodeRef parent, uint32_t entity, uint32_t unresolved_reference) {
        if (entity != std::numeric_limits<uint32_t>::max()) quoted_id(parent, "entity", entity);
        if (unresolved_reference != std::numeric_limits<uint32_t>::max()) {
            graph.unresolved_references.at(unresolved_reference);
            parent.append_child() << c4::yml::key("unresolved-reference") << unresolved_reference;
        }
    };
    auto nodes = sequence(out, "nodes");
    if (!graph.nodes.empty()) nodes.set_container_style(c4::yml::BLOCK);
    for (size_t ni = 0; ni < graph.nodes.size(); ++ni) {
        auto& value = *graph.nodes[ni];
        auto node = nodes.append_child();
        node |= c4::yml::MAP;
        node.append_child() << c4::yml::key("id") << ni;
        node.append_child() << c4::yml::key("script") << names.at(value.script);
        node.append_child() << c4::yml::key("statement-id") << value.statement_id;
        node.append_child() << c4::yml::key("type") << buffers::parser::EnumNameStatementType(value.statement_type);
        auto text = node.append_child();
        text << c4::yml::key("sql") << value.sql;
        text.set_val_style(c4::yml::VAL_DQUO);
        node.append_child() << c4::yml::key("produces-output") << c4::fmt::boolalpha(value.produces_output);
        node.append_child() << c4::yml::key("barrier") << c4::fmt::boolalpha(value.barrier);
        auto accesses = sequence(node, "accesses");
        if (!value.accesses.empty()) accesses.set_container_style(c4::yml::BLOCK);
        for (auto& access : value.accesses) {
            auto entry = accesses.append_child();
            entry |= c4::yml::MAP;
            target(entry, access->entity, access->unresolved_reference);
            entry.append_child() << c4::yml::key("mode")
                                 << buffers::execution::EnumNameExecutionGraphAccessMode(access->mode);
        }
    }
    auto edges = sequence(out, "edges");
    if (!graph.edges.empty()) edges.set_container_style(c4::yml::BLOCK);
    for (auto& value : graph.edges) {
        auto node = edges.append_child();
        node |= c4::yml::MAP;
        node.append_child() << c4::yml::key("from") << value->from;
        node.append_child() << c4::yml::key("to") << value->to;
        node.append_child() << c4::yml::key("reason")
                            << buffers::execution::EnumNameExecutionGraphEdgeReason(value->reason);
        target(node, value->entity, value->unresolved_reference);
    }
    auto diagnostics = sequence(out, "diagnostics");
    if (!graph.diagnostics.empty()) diagnostics.set_container_style(c4::yml::BLOCK);
    for (auto& value : graph.diagnostics) {
        auto node = diagnostics.append_child();
        node |= c4::yml::MAP;
        if (value->node != std::numeric_limits<uint32_t>::max()) {
            node.append_child() << c4::yml::key("node") << value->node;
        }
        node.append_child() << c4::yml::key("message") << value->message;
    }
}

void PlannerSnapshotTest::Test() const {
    auto fixture = tree->ref(node_id);
    ASSERT_TRUE(fixture.has_child("expected"));
    c4::yml::Tree actual;
    actual.rootref() |= c4::yml::MAP;
    auto expected = actual.rootref().append_child();
    expected << c4::yml::key("expected");
    Encode(expected, fixture);
    ASSERT_TRUE(Matches(expected, fixture["expected"]));
    c4::yml::Tree repeated;
    repeated.rootref() |= c4::yml::MAP;
    auto second = repeated.rootref().append_child();
    second << c4::yml::key("expected");
    Encode(second, fixture);
    ASSERT_TRUE(Matches(second, expected)) << "planner snapshot must be deterministic";
}

struct PlannerSnapshotFile {
    c4::yml::Tree tree;
    std::vector<PlannerSnapshotTest> tests;
};
static std::unordered_map<std::string, PlannerSnapshotFile> TEST_FILES;

void PlannerSnapshotTest::LoadTests(const std::filesystem::path& snapshots_dir) {
    if (!TEST_FILES.empty()) return;
    for (auto& path : std::filesystem::directory_iterator(snapshots_dir)) {
        if (path.path().extension() != ".yaml" || path.path().stem().extension() == ".tpl") continue;
        std::ifstream input(path.path());
        if (!input) throw std::runtime_error("cannot read planner snapshot: " + path.path().string());
        std::stringstream buffer;
        buffer << input.rdbuf();
        auto& file = TEST_FILES[path.path().filename().string()];
        auto content = buffer.str();
        c4::yml::parse_in_arena(c4::to_csubstr(content), &file.tree);
        for (auto node : file.tree.rootref()["planner-snapshots"].children()) {
            auto value = node["name"].val();
            file.tests.push_back({std::string(value.str, value.len), &file.tree, node.id()});
        }
    }
}

std::vector<const PlannerSnapshotTest*> PlannerSnapshotTest::GetTests(std::string_view filename) {
    if (TEST_FILES.empty()) {
        auto root = GetRunfilesSnapshotRoot();
        LoadTests((root.empty() ? std::filesystem::path(".") : root) / "snapshots" / "planner");
    }
    auto found = TEST_FILES.find(std::string(filename));
    if (found == TEST_FILES.end()) throw std::runtime_error("missing planner snapshot: " + std::string(filename));
    if (found->second.tests.empty()) throw std::runtime_error("empty planner snapshot: " + std::string(filename));
    std::vector<const PlannerSnapshotTest*> tests;
    for (auto& test : found->second.tests) tests.push_back(&test);
    return tests;
}

}  // namespace dashql::testing
