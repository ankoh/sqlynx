#include "dashql/planner.h"

#include <array>
#include <flatbuffers/verifier.h>

#include "gtest/gtest.h"

using namespace dashql;
using namespace dashql::buffers::execution;

namespace {

using Reason = ExecutionGraphEdgeReason;
using Mode = ExecutionGraphAccessMode;

std::unique_ptr<Script> Analyze(Catalog& catalog, std::string_view sql, bool publish = false) {
    auto script = std::make_unique<Script>(catalog);
    script->ReplaceText(sql);
    script->Analyze();
    if (publish) {
        catalog.LoadScript(*script, 0);
        script->Analyze(false);
    }
    return script;
}

ExecutionGraphT Plan(Script& script) {
    std::array inputs{PlannerInput{&script}};
    return Planner::Plan(inputs);
}

bool HasEdge(const ExecutionGraphT& graph, uint32_t from, uint32_t to, Reason reason) {
    for (auto& edge : graph.edges) {
        if (edge->from == from && edge->to == to && edge->reason == reason) return true;
    }
    return false;
}

bool HasDiagnostic(const ExecutionGraphT& graph, std::string_view text) {
    for (auto& diagnostic : graph.diagnostics) {
        if (diagnostic->message.find(text) != std::string::npos) return true;
    }
    return false;
}

std::vector<uint8_t> Serialize(const ExecutionGraphT& graph) {
    for (auto& node : graph.nodes) {
        for (auto& access : node->accesses) {
            EXPECT_NE(access->entity != UINT32_MAX, access->unresolved_reference != UINT32_MAX);
        }
    }
    for (auto& edge : graph.edges) {
        if (edge->reason == Reason::BARRIER) {
            EXPECT_EQ(edge->entity, UINT32_MAX);
            EXPECT_EQ(edge->unresolved_reference, UINT32_MAX);
        } else {
            EXPECT_NE(edge->entity != UINT32_MAX, edge->unresolved_reference != UINT32_MAX);
        }
    }
    flatbuffers::FlatBufferBuilder builder;
    builder.Finish(ExecutionGraph::Pack(builder, &graph));
    flatbuffers::Verifier verifier{builder.GetBufferPointer(), builder.GetSize()};
    EXPECT_TRUE(verifier.VerifyBuffer<ExecutionGraph>(nullptr));
    return {builder.GetBufferPointer(), builder.GetBufferPointer() + builder.GetSize()};
}

TEST(PlannerTest, IndependentReadsWithinAndAcrossScripts) {
    Catalog catalog;
    auto schema = Analyze(catalog, "create table a (id int); create table b (id int)", true);
    auto first = Analyze(catalog, "-- description\nselect * from a; select * from a; select * from b");
    auto second = Analyze(catalog, "select 1; select * from b");
    std::array inputs{PlannerInput{first.get()}, PlannerInput{second.get()}};
    auto graph = Planner::Plan(inputs);
    ASSERT_TRUE(graph.valid);
    ASSERT_EQ(graph.nodes.size(), 5);
    EXPECT_TRUE(graph.edges.empty());
    ASSERT_EQ(graph.scripts.size(), 2);
    EXPECT_EQ(graph.scripts[0]->script_id, first->GetCatalogEntryId());
    EXPECT_EQ(graph.scripts[0]->text_version, first->text_version);
    EXPECT_EQ(graph.scripts[1]->text_version, second->text_version);
    EXPECT_EQ(graph.scripts[0]->analyzed_text_version, first->text_version);
    EXPECT_EQ(graph.scripts[1]->analyzed_text_version, second->text_version);
    EXPECT_EQ(graph.scripts[0]->analyzed_catalog_revision, catalog.GetVersion());
    EXPECT_EQ(graph.scripts[1]->analyzed_catalog_revision, catalog.GetVersion());
    EXPECT_EQ(graph.nodes[3]->script, 1);
    ASSERT_EQ(graph.entities.size(), 2);
    EXPECT_TRUE(graph.unresolved_references.empty());
    schema->GetAnalyzedScript()->GetTables().ForEach([&](size_t i, const CatalogEntry::TableDeclaration& table) {
        ASSERT_NE(graph.entities[i]->catalog_object_id, nullptr);
        EXPECT_EQ(graph.entities[i]->catalog_object_id->object_type(), ExecutionGraphEntityType::TABLE);
        EXPECT_EQ(graph.entities[i]->catalog_object_id->object_id(), table.GetTableID().Pack());
        EXPECT_EQ(graph.entities[i]->catalog_object_id->sub_object_id(), 0);
        auto [database, schema_id] = table.catalog_schema_id.UnpackSchemaID();
        EXPECT_EQ(graph.entities[i]->catalog_database_id, database);
        EXPECT_EQ(graph.entities[i]->catalog_schema_id, schema_id);
    });
    EXPECT_EQ(graph.nodes[0]->sql, "select * from a");
    for (auto& node : graph.nodes) {
        EXPECT_TRUE(node->produces_output);
        EXPECT_FALSE(node->barrier);
    }
    auto analyzed = first->GetAnalyzedScript();
    auto version = catalog.GetVersion();
    EXPECT_EQ(Serialize(graph), Serialize(Planner::Plan(inputs)));
    EXPECT_EQ(first->GetAnalyzedScript(), analyzed);
    EXPECT_EQ(catalog.GetVersion(), version);
}

TEST(PlannerTest, NativeTextVersionsAboveUint32RoundTripWithoutTruncation) {
    static_assert(sizeof(TextVersion) == sizeof(uint64_t));
    Catalog catalog;
    for (uint64_t initial : {uint64_t{UINT32_MAX}, (uint64_t{1} << 40) + 123}) {
        Script script{catalog};
        script.text_version = initial;
        script.ReplaceText("select 1");
        script.Analyze();
        const auto version = initial + 1;
        ASSERT_EQ(script.text_version, version);
        ASSERT_EQ(script.GetAnalyzedScript()->parsed_script->scanned_script->text_version, version);
        auto graph = Plan(script);
        ASSERT_TRUE(graph.valid);
        ASSERT_EQ(graph.scripts.size(), 1);
        EXPECT_EQ(graph.scripts[0]->text_version, version);
        EXPECT_EQ(graph.scripts[0]->analyzed_text_version, version);
        auto bytes = Serialize(graph);
        auto* packed = flatbuffers::GetRoot<ExecutionGraph>(bytes.data());
        ASSERT_EQ(packed->scripts()->size(), 1);
        EXPECT_EQ(packed->scripts()->Get(0)->text_version(), version);
        EXPECT_EQ(packed->scripts()->Get(0)->analyzed_text_version(), version);
        auto unpacked = std::unique_ptr<ExecutionGraphT>{packed->UnPack()};
        EXPECT_EQ(unpacked->scripts[0]->text_version, version);
        EXPECT_EQ(unpacked->scripts[0]->analyzed_text_version, version);
    }
}

TEST(PlannerTest, StaleNativeTextVersionRejectsAllExecutableNodes) {
    Catalog catalog;
    auto current = Analyze(catalog, "select 1");
    Script stale{catalog};
    stale.text_version = UINT32_MAX;
    stale.ReplaceText("select 2");
    stale.Analyze();
    auto snapshot = stale.GetAnalyzedScript();
    const auto analyzed_version = stale.text_version;
    auto previous = Plan(stale);
    ASSERT_TRUE(previous.valid);
    ASSERT_EQ(previous.scripts.size(), 1);
    stale.InsertTextAt(0, " ");
    ASSERT_EQ(stale.text_version, analyzed_version + 1);
    ASSERT_EQ(snapshot->parsed_script->scanned_script->text_version, analyzed_version);
    EXPECT_EQ(previous.scripts[0]->text_version, analyzed_version);
    EXPECT_EQ(previous.scripts[0]->analyzed_text_version, analyzed_version);
    EXPECT_NE(previous.scripts[0]->text_version, stale.text_version);
    std::array inputs{PlannerInput{current.get()}, PlannerInput{&stale}};
    for (int stage = 0; stage < 3; ++stage) {
        if (stage == 1) stale.Scan();
        if (stage == 2) stale.Parse();
        auto graph = Planner::Plan(inputs);
        EXPECT_FALSE(graph.valid);
        EXPECT_TRUE(HasDiagnostic(graph, "missing or stale script analysis"));
        EXPECT_TRUE(graph.nodes.empty());
        EXPECT_TRUE(graph.edges.empty());
        EXPECT_TRUE(graph.entities.empty());
        EXPECT_EQ(stale.GetAnalyzedScript(), snapshot);
        auto bytes = Serialize(graph);
        auto* packed = flatbuffers::GetRoot<ExecutionGraph>(bytes.data());
        EXPECT_FALSE(packed->valid());
        EXPECT_TRUE(!packed->nodes() || packed->nodes()->size() == 0);
    }
    stale.Analyze();
    auto graph = Planner::Plan(inputs);
    ASSERT_TRUE(graph.valid);
    ASSERT_EQ(graph.nodes.size(), 2);
    ASSERT_EQ(graph.scripts.size(), 2);
    EXPECT_EQ(graph.scripts[1]->text_version, stale.text_version);
    EXPECT_EQ(graph.scripts[1]->analyzed_text_version, stale.text_version);
}

TEST(PlannerTest, ResourceTimelineTracksAllHazardsAndOutstandingReaders) {
    Catalog catalog;
    auto schema = Analyze(catalog, "create table a (id int)", true);
    auto script = Analyze(catalog,
        "select * from a; select * from a; insert into a values (1); "
        "select * from a; insert into a values (2) returning id; insert into a values (3)");
    auto graph = Plan(*script);
    ASSERT_TRUE(graph.valid);
    ASSERT_EQ(graph.nodes.size(), 6);
    EXPECT_FALSE(HasEdge(graph, 0, 1, Reason::READ_AFTER_WRITE));
    EXPECT_TRUE(HasEdge(graph, 0, 2, Reason::WRITE_AFTER_READ));
    EXPECT_TRUE(HasEdge(graph, 1, 2, Reason::WRITE_AFTER_READ));
    EXPECT_TRUE(HasEdge(graph, 2, 3, Reason::READ_AFTER_WRITE));
    EXPECT_TRUE(HasEdge(graph, 2, 4, Reason::WRITE_AFTER_WRITE));
    EXPECT_TRUE(HasEdge(graph, 3, 4, Reason::WRITE_AFTER_READ));
    EXPECT_TRUE(HasEdge(graph, 4, 5, Reason::WRITE_AFTER_WRITE));
    EXPECT_FALSE(graph.nodes[2]->produces_output);
    EXPECT_TRUE(graph.nodes[4]->produces_output);
}

TEST(PlannerTest, DeleteReturningAndSourceReadsTrackMutationHazards) {
    Catalog catalog;
    auto schema = Analyze(catalog, "create table a (id int); create table b (id int)", true);
    auto script = Analyze(catalog,
        "select * from a; delete from a where id in (select id from b) returning id; "
        "select * from a; insert into b values (1); delete from a; insert into a values (2) returning id");
    ASSERT_TRUE(script->GetParsedScript()->errors.empty());
    auto graph = Plan(*script);
    ASSERT_TRUE(graph.valid);
    ASSERT_EQ(graph.nodes.size(), 6);
    EXPECT_EQ(graph.nodes[1]->statement_type, buffers::parser::StatementType::DELETE);
    EXPECT_TRUE(graph.nodes[1]->produces_output);
    EXPECT_FALSE(graph.nodes[4]->produces_output);
    EXPECT_TRUE(graph.nodes[5]->produces_output);
    ASSERT_EQ(graph.nodes[1]->accesses.size(), 2);
    for (auto& access : graph.nodes[1]->accesses) {
        auto& name = graph.entities[access->entity]->name;
        EXPECT_EQ(access->mode, name == "a" ? Mode::WRITE : Mode::READ);
    }
    EXPECT_TRUE(HasEdge(graph, 0, 1, Reason::WRITE_AFTER_READ));
    EXPECT_TRUE(HasEdge(graph, 1, 2, Reason::READ_AFTER_WRITE));
    EXPECT_TRUE(HasEdge(graph, 1, 3, Reason::WRITE_AFTER_READ));
    EXPECT_TRUE(HasEdge(graph, 1, 4, Reason::WRITE_AFTER_WRITE));
    EXPECT_TRUE(HasEdge(graph, 2, 4, Reason::WRITE_AFTER_READ));
    EXPECT_TRUE(HasEdge(graph, 4, 5, Reason::WRITE_AFTER_WRITE));
    Serialize(graph);
}

TEST(PlannerTest, ExplainOutputsRemainIndependentReadsEvenForDmlBodies) {
    Catalog catalog;
    auto schema = Analyze(catalog, "create table a (id int); create table b (id int)", true);
    auto script = Analyze(catalog,
        "select * from a; explain select * from a; explain insert into a select * from b; "
        "explain delete from a returning id; explain expressions (1 + 2); "
        "insert into a values (1); explain insert into a values (2)");
    ASSERT_TRUE(script->GetParsedScript()->errors.empty());
    auto graph = Plan(*script);
    ASSERT_TRUE(graph.valid);
    ASSERT_EQ(graph.nodes.size(), 7);
    for (auto index : {1, 2, 3, 4, 6}) {
        EXPECT_EQ(graph.nodes[index]->statement_type, buffers::parser::StatementType::EXPLAIN);
        EXPECT_TRUE(graph.nodes[index]->produces_output);
        EXPECT_FALSE(graph.nodes[index]->barrier);
        for (auto& access : graph.nodes[index]->accesses) EXPECT_EQ(access->mode, Mode::READ);
    }
    ASSERT_EQ(graph.nodes[2]->accesses.size(), 2);
    EXPECT_TRUE(graph.nodes[4]->accesses.empty());
    EXPECT_EQ(graph.nodes[2]->sql, "explain insert into a select * from b");
    EXPECT_FALSE(HasEdge(graph, 0, 1, Reason::READ_AFTER_WRITE));
    EXPECT_FALSE(HasEdge(graph, 1, 2, Reason::WRITE_AFTER_READ));
    for (auto index : {0, 1, 2, 3}) EXPECT_TRUE(HasEdge(graph, index, 5, Reason::WRITE_AFTER_READ));
    EXPECT_TRUE(HasEdge(graph, 5, 6, Reason::READ_AFTER_WRITE));
    EXPECT_FALSE(graph.nodes[5]->produces_output);
    size_t analyzer_writes = 0;
    script->GetAnalyzedScript()->table_references.ForEach([&](size_t, const TableReference& ref) {
        if (ref.role == TableReference::Role::Write) ++analyzer_writes;
    });
    EXPECT_EQ(analyzer_writes, 4);
    Serialize(graph);
}

TEST(PlannerTest, DeleteUsingCteAndSelfReadsRetainOnlyPhysicalResources) {
    Catalog catalog;
    auto schema = Analyze(catalog, "create table a (id int); create table b (id int)", true);
    auto first = Analyze(catalog,
        "with c as (select * from b) delete from a using c where a.id = c.id returning a.id; "
        "delete from a where id in (select id from a)");
    auto second = Analyze(catalog, "select * from a; insert into b values (1)");
    ASSERT_TRUE(first->GetParsedScript()->errors.empty());
    std::array inputs{PlannerInput{first.get()}, PlannerInput{second.get()}};
    auto graph = Planner::Plan(inputs);
    ASSERT_TRUE(graph.valid);
    ASSERT_EQ(graph.nodes.size(), 4);
    ASSERT_EQ(graph.entities.size(), 2);
    EXPECT_TRUE(graph.unresolved_references.empty());
    EXPECT_FALSE(graph.nodes[0]->barrier);
    ASSERT_EQ(graph.nodes[0]->accesses.size(), 2);
    ASSERT_EQ(graph.nodes[1]->accesses.size(), 1);
    EXPECT_EQ(graph.nodes[1]->accesses[0]->mode, Mode::WRITE);
    EXPECT_TRUE(HasEdge(graph, 0, 1, Reason::WRITE_AFTER_WRITE));
    EXPECT_TRUE(HasEdge(graph, 1, 2, Reason::READ_AFTER_WRITE));
    EXPECT_TRUE(HasEdge(graph, 0, 3, Reason::WRITE_AFTER_READ));
    for (auto& edge : graph.edges) EXPECT_NE(edge->from, edge->to);
    Serialize(graph);
}

TEST(PlannerTest, ExplainDeclarationsNeverPublishCatalogTablesOrProducers) {
    Catalog catalog;
    auto schema = Analyze(catalog, "create table source (id int)", true);
    for (auto sql : {"explain create table phantom (id int)",
                     "explain create table phantom as select * from source",
                     "explain create view phantom as select * from source",
                     "explain select * into phantom from source"}) {
        auto script = Analyze(catalog, sql, true);
        ASSERT_TRUE(script->GetParsedScript()->errors.empty()) << sql;
        EXPECT_EQ(script->GetAnalyzedScript()->GetTables().GetSize(), 0) << sql;
        auto graph = Plan(*script);
        ASSERT_TRUE(graph.valid) << sql;
        ASSERT_EQ(graph.nodes.size(), 1);
        EXPECT_TRUE(graph.nodes[0]->produces_output);
        EXPECT_FALSE(graph.nodes[0]->barrier);
        EXPECT_EQ(graph.nodes[0]->accesses.size(), std::string_view{sql}.find("source") == std::string_view::npos ? 0 : 1);
        for (auto& entity : graph.entities) EXPECT_EQ(entity->name, "source");
        for (auto& access : graph.nodes[0]->accesses) EXPECT_EQ(access->mode, Mode::READ);
        auto consumer = Analyze(catalog, "select * from phantom");
        std::array inputs{PlannerInput{script.get()}, PlannerInput{consumer.get()}};
        graph = Planner::Plan(inputs);
        ASSERT_TRUE(graph.valid);
        ASSERT_EQ(graph.unresolved_references.size(), 1);
        EXPECT_EQ(graph.unresolved_references[0]->name, "phantom");
        EXPECT_TRUE(HasDiagnostic(graph, "unresolved relation"));
        EXPECT_FALSE(HasDiagnostic(graph, "later producer"));
        catalog.DropScript(*script);
    }
}

TEST(PlannerTest, ExecutionEnabledExplainRejectsMutationsButAllowsQueries) {
    Catalog catalog;
    auto schema = Analyze(catalog, "create table a (id int)", true);
    for (auto sql : {"explain (analyze) insert into a values (1)",
                     "explain (ANALYSE true) delete from a returning id",
                     "explain (format 'analyze') insert into a values (1)",
                     "explain (analyze false, analyze true) insert into a values (1)",
                     "explain (analyze 'unknown') insert into a values (1)",
                     "explain (analyze) create table phantom as select * from a",
                     "explain (analyze) select * into phantom from a"}) {
        auto script = Analyze(catalog, sql);
        ASSERT_TRUE(script->GetParsedScript()->errors.empty()) << sql;
        EXPECT_EQ(script->GetAnalyzedScript()->GetTables().GetSize(), 0);
        auto graph = Plan(*script);
        EXPECT_FALSE(graph.valid) << sql;
        EXPECT_TRUE(HasDiagnostic(graph, "execution-enabled EXPLAIN with a mutating body")) << sql;
        ASSERT_EQ(graph.nodes.size(), 1);
        EXPECT_TRUE(graph.nodes[0]->produces_output);
        EXPECT_TRUE(graph.nodes[0]->barrier);
        EXPECT_TRUE(graph.nodes[0]->sql.empty());
        if (std::string_view{sql}.find("insert") != std::string_view::npos ||
            std::string_view{sql}.find("delete") != std::string_view::npos) {
            ASSERT_EQ(graph.nodes[0]->accesses.size(), 1);
            EXPECT_EQ(graph.nodes[0]->accesses[0]->mode, Mode::WRITE);
        }
    }
    for (auto sql : {"explain (analyze) select * from a", "explain (analyse true) expressions (1)",
                     "explain (analyze false) insert into a values (1)",
                     "explain (analyse false) delete from a",
                     "explain (format 'analyze') select * from a",
                     "explain (verbose true) select 'analyze' from a"}) {
        auto script = Analyze(catalog, sql);
        ASSERT_TRUE(script->GetParsedScript()->errors.empty()) << sql;
        auto graph = Plan(*script);
        EXPECT_TRUE(graph.valid) << sql;
        ASSERT_EQ(graph.nodes.size(), 1);
        EXPECT_TRUE(graph.nodes[0]->produces_output);
        EXPECT_FALSE(graph.nodes[0]->barrier);
        for (auto& access : graph.nodes[0]->accesses) EXPECT_EQ(access->mode, Mode::READ);
    }
}

TEST(PlannerTest, CrossScriptCreationAndDropRecreateRetainDeclarationIds) {
    Catalog catalog;
    auto create = Analyze(catalog, "create table a (id int)", true);
    auto use = Analyze(catalog, "select * from a; drop table a; create table a (id int); select * from a");
    std::array inputs{PlannerInput{create.get()}, PlannerInput{use.get()}};
    auto graph = Planner::Plan(inputs);
    ASSERT_TRUE(graph.valid);
    ASSERT_EQ(graph.nodes.size(), 5);
    ASSERT_EQ(graph.entities.size(), 2);
    EXPECT_TRUE(graph.unresolved_references.empty());
    auto old_entity = graph.nodes[0]->accesses[0]->entity;
    auto new_entity = graph.nodes[3]->accesses[0]->entity;
    EXPECT_NE(old_entity, new_entity);
    EXPECT_EQ(graph.nodes[1]->accesses[0]->entity, old_entity);
    EXPECT_EQ(graph.nodes[2]->accesses[0]->entity, old_entity);
    EXPECT_EQ(graph.nodes[4]->accesses[0]->entity, new_entity);
    EXPECT_EQ(graph.entities[old_entity]->catalog_object_id->object_id(),
              create->GetAnalyzedScript()->GetTables()[0].GetTableID().Pack());
    EXPECT_EQ(graph.entities[new_entity]->catalog_object_id->object_id(),
              use->GetAnalyzedScript()->GetTables()[0].GetTableID().Pack());
    for (auto& edge : graph.edges) {
        EXPECT_EQ(edge->entity, graph.nodes[edge->to]->accesses[0]->entity);
        EXPECT_EQ(edge->unresolved_reference, UINT32_MAX);
    }
    EXPECT_TRUE(HasEdge(graph, 0, 1, Reason::DDL));
    EXPECT_TRUE(HasEdge(graph, 1, 2, Reason::DDL));
    EXPECT_TRUE(HasEdge(graph, 2, 3, Reason::DDL));
    EXPECT_TRUE(HasEdge(graph, 3, 4, Reason::DDL));
    for (auto index : {0, 2, 3}) {
        ASSERT_EQ(graph.nodes[index]->accesses.size(), 1);
        EXPECT_EQ(graph.nodes[index]->accesses[0]->mode, Mode::DDL);
    }
}

TEST(PlannerTest, CreateAsViewAndSelectIntoCollectBaseReadsAndTargets) {
    Catalog catalog;
    auto schema = Analyze(catalog, "create table source (id int)", true);
    auto script = Analyze(catalog,
        "create table target as select * from source; "
        "create view v as select * from source; select * into copied from source; select * from v");
    auto graph = Plan(*script);
    ASSERT_TRUE(graph.valid);
    ASSERT_EQ(graph.nodes.size(), 4);
    EXPECT_EQ(graph.entities.size(), 4);
    for (auto index : {0, 1, 2}) {
        ASSERT_EQ(graph.nodes[index]->accesses.size(), 2);
        EXPECT_FALSE(graph.nodes[index]->produces_output);
    }
    EXPECT_TRUE(graph.nodes[3]->barrier);
    EXPECT_TRUE(HasDiagnostic(graph, "view dependencies"));
    EXPECT_TRUE(HasEdge(graph, 0, 3, Reason::BARRIER));
    EXPECT_TRUE(HasEdge(graph, 2, 3, Reason::BARRIER));
}

TEST(PlannerTest, CteBindingsAreNotPhysicalResourcesButBaseTablesAre) {
    Catalog catalog;
    auto schema = Analyze(catalog, "create table source (id int)", true);
    auto script = Analyze(catalog,
        "with c as (select * from source), d as (select * from c) select * from d; "
        "insert into source select * from source returning id");
    auto graph = Plan(*script);
    ASSERT_TRUE(graph.valid);
    ASSERT_EQ(graph.entities.size(), 1);
    ASSERT_EQ(graph.nodes.size(), 2);
    EXPECT_FALSE(graph.nodes[0]->barrier);
    ASSERT_EQ(graph.nodes[1]->accesses.size(), 1);
    EXPECT_EQ(graph.nodes[1]->accesses[0]->mode, Mode::WRITE);
    EXPECT_TRUE(HasEdge(graph, 0, 1, Reason::WRITE_AFTER_READ));
}

TEST(PlannerTest, UnresolvedRelationsAreOrderedBarriersNotIndependentReads) {
    Catalog catalog;
    auto script = Analyze(catalog, "select 1; select * from missing; select 2; select 3");
    auto graph = Plan(*script);
    ASSERT_TRUE(graph.valid);
    ASSERT_EQ(graph.nodes.size(), 4);
    EXPECT_TRUE(graph.entities.empty());
    ASSERT_EQ(graph.unresolved_references.size(), 1);
    EXPECT_EQ(graph.unresolved_references[0]->name, "missing");
    ASSERT_EQ(graph.nodes[1]->accesses.size(), 1);
    EXPECT_EQ(graph.nodes[1]->accesses[0]->entity, UINT32_MAX);
    EXPECT_EQ(graph.nodes[1]->accesses[0]->unresolved_reference, 0);
    for (auto& edge : graph.edges) {
        EXPECT_EQ(edge->entity, UINT32_MAX);
        EXPECT_EQ(edge->unresolved_reference, UINT32_MAX);
    }
    EXPECT_TRUE(graph.nodes[1]->barrier);
    EXPECT_TRUE(HasDiagnostic(graph, "unresolved relation"));
    EXPECT_TRUE(HasEdge(graph, 0, 1, Reason::BARRIER));
    EXPECT_TRUE(HasEdge(graph, 1, 2, Reason::BARRIER));
    EXPECT_TRUE(HasEdge(graph, 1, 3, Reason::BARRIER));
    EXPECT_FALSE(HasEdge(graph, 2, 3, Reason::BARRIER));
}

TEST(PlannerTest, UnknownDropIsAnUnresolvedBarrierWithoutSyntheticIdentity) {
    Catalog catalog;
    auto script = Analyze(catalog, "select * from db.s.missing; drop table missing; select 1");
    auto graph = Plan(*script);
    ASSERT_TRUE(graph.valid);
    EXPECT_TRUE(graph.entities.empty());
    ASSERT_EQ(graph.unresolved_references.size(), 2);
    EXPECT_TRUE(graph.nodes[1]->barrier);
    EXPECT_TRUE(HasDiagnostic(graph, "unresolved DROP"));
    EXPECT_TRUE(HasEdge(graph, 0, 1, Reason::BARRIER));
    EXPECT_TRUE(HasEdge(graph, 1, 2, Reason::BARRIER));
    ASSERT_EQ(graph.nodes[1]->accesses.size(), 1);
    EXPECT_EQ(graph.nodes[1]->accesses[0]->entity, UINT32_MAX);
    EXPECT_NE(graph.nodes[1]->accesses[0]->unresolved_reference, UINT32_MAX);
    Serialize(graph);
}

TEST(PlannerTest, RepeatedDeclarationsInOneScriptKeepDistinctNativeIdentities) {
    Catalog catalog;
    auto script = Analyze(catalog,
        "create table a (id int); select * from a; drop table a; "
        "create table a (id int); select * from a");
    auto graph = Plan(*script);
    ASSERT_TRUE(graph.valid);
    auto& tables = script->GetAnalyzedScript()->GetTables();
    ASSERT_EQ(tables.GetSize(), 2);
    ASSERT_EQ(graph.entities.size(), 2);
    EXPECT_EQ(graph.entities[0]->catalog_object_id->object_id(), tables[0].GetTableID().Pack());
    EXPECT_EQ(graph.entities[1]->catalog_object_id->object_id(), tables[1].GetTableID().Pack());
    EXPECT_EQ(graph.nodes[1]->accesses[0]->entity, graph.nodes[0]->accesses[0]->entity);
    EXPECT_EQ(graph.nodes[2]->accesses[0]->entity, graph.nodes[0]->accesses[0]->entity);
    EXPECT_EQ(graph.nodes[4]->accesses[0]->entity, graph.nodes[3]->accesses[0]->entity);
    EXPECT_TRUE(HasEdge(graph, 0, 1, Reason::DDL));
    EXPECT_TRUE(HasEdge(graph, 1, 2, Reason::DDL));
    EXPECT_TRUE(HasEdge(graph, 2, 3, Reason::DDL));
    EXPECT_TRUE(HasEdge(graph, 3, 4, Reason::DDL));
    Serialize(graph);
}

TEST(PlannerTest, EarlierExternalLifetimeIsNotReboundToFutureCreate) {
    Catalog catalog;
    auto schema = Analyze(catalog, "create table a (id int)", true);
    auto script = Analyze(catalog, "select * from a; drop table a; create table a (id int); select * from a");
    auto graph = Plan(*script);
    ASSERT_TRUE(graph.valid);
    ASSERT_EQ(graph.entities.size(), 2);
    EXPECT_EQ(graph.entities[0]->catalog_object_id->object_id(),
              schema->GetAnalyzedScript()->GetTables()[0].GetTableID().Pack());
    EXPECT_EQ(graph.entities[1]->catalog_object_id->object_id(),
              script->GetAnalyzedScript()->GetTables()[0].GetTableID().Pack());
    EXPECT_EQ(graph.nodes[0]->accesses[0]->entity, graph.nodes[1]->accesses[0]->entity);
    EXPECT_NE(graph.nodes[1]->accesses[0]->entity, graph.nodes[2]->accesses[0]->entity);
    EXPECT_TRUE(HasEdge(graph, 0, 1, Reason::DDL));
    EXPECT_TRUE(HasEdge(graph, 1, 2, Reason::DDL));
    EXPECT_TRUE(HasEdge(graph, 2, 3, Reason::DDL));
    Serialize(graph);
}

TEST(PlannerTest, SameNameCreateAsKeepsBothIdentityAccessesAndStrongestTimelineEffect) {
    Catalog catalog;
    auto schema = Analyze(catalog, "create table a (id int)", true);
    auto script = Analyze(catalog, "select * from a; create table a as select * from a; select * from a");
    auto graph = Plan(*script);
    ASSERT_TRUE(graph.valid);
    ASSERT_EQ(graph.entities.size(), 2);
    ASSERT_EQ(graph.nodes[1]->accesses.size(), 2);
    EXPECT_EQ(graph.nodes[1]->accesses[0]->mode, Mode::READ);
    EXPECT_EQ(graph.nodes[1]->accesses[1]->mode, Mode::DDL);
    EXPECT_TRUE(HasEdge(graph, 0, 1, Reason::DDL));
    EXPECT_TRUE(HasEdge(graph, 1, 2, Reason::DDL));
    for (auto& edge : graph.edges) EXPECT_EQ(edge->entity, graph.nodes[1]->accesses[1]->entity);
    Serialize(graph);
}

TEST(PlannerTest, ForwardResolvedProducerIsRejectedRatherThanReordered) {
    Catalog catalog;
    auto script = Analyze(catalog, "select * from later; create table later (id int)");
    auto graph = Plan(*script);
    EXPECT_FALSE(graph.valid);
    EXPECT_TRUE(HasDiagnostic(graph, "later producer"));
    auto producer = Analyze(catalog, "create table cross_script (id int)", true);
    auto consumer = Analyze(catalog, "select * from cross_script");
    std::array inputs{PlannerInput{consumer.get()}, PlannerInput{producer.get()}};
    graph = Planner::Plan(inputs);
    EXPECT_FALSE(graph.valid);
    EXPECT_TRUE(HasDiagnostic(graph, "later producer"));
    for (auto& edge : graph.edges) EXPECT_LT(edge->from, edge->to);
}

TEST(PlannerTest, InvalidSnapshotsDoNotProducePartialExecutablePlans) {
    Catalog catalog;
    auto script = Analyze(catalog, "select 1");
    std::array null_inputs{PlannerInput{nullptr}};
    EXPECT_FALSE(Planner::Plan(null_inputs).valid);
    std::array duplicates{PlannerInput{script.get()}, PlannerInput{script.get()}};
    EXPECT_FALSE(Planner::Plan(duplicates).valid);
    Catalog other;
    auto foreign = Analyze(other, "select 2");
    std::array mixed{PlannerInput{script.get()}, PlannerInput{foreign.get()}};
    EXPECT_FALSE(Planner::Plan(mixed).valid);
    Script missing{catalog};
    EXPECT_FALSE(Plan(missing).valid);
    script->InsertTextAt(0, " ");
    EXPECT_FALSE(Plan(*script).valid);
    EXPECT_TRUE(Plan(*script).nodes.empty());
    script->Scan();
    EXPECT_FALSE(Plan(*script).valid);
    script->Parse();
    EXPECT_FALSE(Plan(*script).valid);
    EXPECT_TRUE(Planner::Plan({}).valid);
    auto empty = Analyze(catalog, "-- only trivia\n /* comment */ ");
    EXPECT_TRUE(Plan(*empty).valid);
}

TEST(PlannerTest, UnsupportedStatementsAndSyntaxNeverPassThrough) {
    Catalog catalog;
    for (auto sql : {"set foo = 1", "attach database 'test.db' as db",
                     "create function f() returns int", "create temp table t (id int)",
                     "select * into temp t from unknown"}) {
        auto script = Analyze(catalog, sql);
        auto graph = Plan(*script);
        EXPECT_FALSE(graph.valid) << sql;
        EXPECT_FALSE(graph.diagnostics.empty()) << sql;
    }
    auto malformed = Analyze(catalog, "select from;");
    EXPECT_FALSE(Plan(*malformed).valid);
    EXPECT_TRUE(Plan(*malformed).nodes.empty());
    auto scanner = Analyze(catalog, "select 'unterminated");
    EXPECT_FALSE(Plan(*scanner).valid);
}

TEST(PlannerTest, AmbiguousReferencesAndDropsAreRejected) {
    Catalog catalog;
    auto schema = Analyze(catalog, "create table s1.a (id int); create table s2.a (id int)", true);
    auto read = Analyze(catalog, "select * from a");
    EXPECT_FALSE(Plan(*read).valid);
    EXPECT_TRUE(HasDiagnostic(Plan(*read), "ambiguous relation"));
    auto drop = Analyze(catalog, "drop table a");
    EXPECT_FALSE(Plan(*drop).valid);
    EXPECT_TRUE(HasDiagnostic(Plan(*drop), "ambiguous DROP"));
    auto qualified = Analyze(catalog, "select * from s1.a; drop table s1.a");
    auto graph = Plan(*qualified);
    EXPECT_TRUE(graph.valid);
    ASSERT_EQ(graph.entities.size(), 1);
    EXPECT_EQ(graph.entities[0]->schema_name, "s1");
    EXPECT_TRUE(HasEdge(graph, 0, 1, Reason::DDL));
}

TEST(PlannerTest, AnalyzerErrorsInvalidateTheOwningStatement) {
    Catalog catalog;
    auto schema = Analyze(catalog, "create table a (id int)", true);
    auto script = Analyze(catalog, "select * from a x, a x");
    auto graph = Plan(*script);
    EXPECT_FALSE(graph.valid);
    EXPECT_TRUE(HasDiagnostic(graph, "duplicate table alias"));
    ASSERT_EQ(graph.nodes.size(), 1);
    EXPECT_TRUE(graph.nodes[0]->barrier);
}

TEST(PlannerTest, UnqualifiedDropMatchesResolvedDatabaseAndSchema) {
    Catalog catalog;
    auto schema = Analyze(catalog, "create table db.s.a (id int)", true);
    auto script = Analyze(catalog, "select * from a; drop table a");
    auto recreate = Analyze(catalog, "create table db.s.a (id int); select * from a");
    std::array inputs{PlannerInput{script.get()}, PlannerInput{recreate.get()}};
    auto graph = Planner::Plan(inputs);
    ASSERT_TRUE(graph.valid);
    ASSERT_EQ(graph.entities.size(), 2);
    EXPECT_EQ(graph.entities[0]->database_name, "db");
    EXPECT_EQ(graph.entities[0]->schema_name, "s");
    EXPECT_TRUE(HasEdge(graph, 0, 1, Reason::DDL));
    EXPECT_TRUE(HasEdge(graph, 1, 2, Reason::DDL));
    EXPECT_TRUE(HasEdge(graph, 2, 3, Reason::DDL));
}

TEST(PlannerTest, UnpublishedCrossScriptDropUsesEarlierLifetimeProducer) {
    Catalog catalog;
    auto create = Analyze(catalog, "create table db.s.a (id int)");
    auto drop = Analyze(catalog, "drop table a");
    std::array inputs{PlannerInput{create.get()}, PlannerInput{drop.get()}};
    auto graph = Planner::Plan(inputs);
    ASSERT_TRUE(graph.valid);
    ASSERT_EQ(graph.entities.size(), 1);
    EXPECT_TRUE(HasEdge(graph, 0, 1, Reason::DDL));
}

TEST(PlannerTest, PublishedViewReadsAreConservativeBarriers) {
    Catalog catalog;
    auto view = Analyze(catalog, "create view v as select 1 as id", true);
    auto script = Analyze(catalog, "select 1; select * from v; select 2");
    auto graph = Plan(*script);
    ASSERT_TRUE(graph.valid);
    EXPECT_TRUE(HasDiagnostic(graph, "view dependencies"));
    EXPECT_TRUE(HasEdge(graph, 0, 1, Reason::BARRIER));
    EXPECT_TRUE(HasEdge(graph, 1, 2, Reason::BARRIER));
}

TEST(PlannerTest, RecreatedLifetimeRejectsReadsBeforeTheNewProducer) {
    Catalog catalog;
    auto script = Analyze(catalog, "create table a (id int); drop table a; select * from a; create table a (id int)");
    auto graph = Plan(*script);
    EXPECT_FALSE(graph.valid);
    EXPECT_TRUE(HasDiagnostic(graph, "later producer"));
}

TEST(PlannerTest, CrossScriptReadsAndWritesShareResourceTimelines) {
    Catalog catalog;
    auto schema = Analyze(catalog, "create table a (id int)", true);
    auto first = Analyze(catalog, "select * from a; insert into a values (1)");
    auto second = Analyze(catalog, "select * from a; insert into a values (2)");
    std::array inputs{PlannerInput{first.get()}, PlannerInput{second.get()}};
    auto graph = Planner::Plan(inputs);
    ASSERT_TRUE(graph.valid);
    ASSERT_EQ(graph.entities.size(), 1);
    EXPECT_TRUE(HasEdge(graph, 0, 1, Reason::WRITE_AFTER_READ));
    EXPECT_TRUE(HasEdge(graph, 1, 2, Reason::READ_AFTER_WRITE));
    EXPECT_TRUE(HasEdge(graph, 1, 3, Reason::WRITE_AFTER_WRITE));
    EXPECT_TRUE(HasEdge(graph, 2, 3, Reason::WRITE_AFTER_READ));
}

TEST(PlannerTest, EarlierLifetimeProducerAllowsLaterNativeDeclarationResolution) {
    Catalog catalog;
    auto earlier = Analyze(catalog, "create table a (id int)");
    auto later = Analyze(catalog, "select * from a; create table a (id int)");
    std::array inputs{PlannerInput{earlier.get()}, PlannerInput{later.get()}};
    auto graph = Planner::Plan(inputs);
    EXPECT_TRUE(graph.valid);
    EXPECT_FALSE(HasDiagnostic(graph, "later producer"));
    EXPECT_TRUE(HasEdge(graph, 0, 1, Reason::DDL));
    EXPECT_TRUE(HasEdge(graph, 1, 2, Reason::DDL));
}

TEST(PlannerTest, VisualizationLowersOnlySourceSelectAndPreservesReadsAndOutputTypes) {
    Catalog catalog;
    auto schema = Analyze(catalog, "create table a (id int)", true);
    auto script = Analyze(catalog,
        "-- description\nselect 1 as id visualize using table (); "
        "with c as (select * from a) select * from c visualize using table (); "
        "insert into a values (1) returning id; select * from a visualize using table (); explain select * from a");
    ASSERT_TRUE(script->GetParsedScript()->errors.empty());
    auto graph = Plan(*script);
    ASSERT_TRUE(graph.valid);
    ASSERT_EQ(graph.nodes.size(), 5);
    EXPECT_EQ(graph.nodes[0]->sql, "select 1 as id");
    EXPECT_EQ(graph.nodes[1]->sql, "with c as (select * from a) select * from c");
    EXPECT_EQ(graph.nodes[3]->sql, "select * from a");
    EXPECT_EQ(graph.nodes[4]->sql, "explain select * from a");
    for (auto index : {0, 1, 3}) {
        EXPECT_EQ(graph.nodes[index]->statement_type, buffers::parser::StatementType::VIS_VISUALISE);
        EXPECT_FALSE(graph.nodes[index]->barrier);
    }
    for (auto& node : graph.nodes) EXPECT_TRUE(node->produces_output);
    EXPECT_TRUE(graph.nodes[0]->accesses.empty());
    ASSERT_EQ(graph.nodes[1]->accesses.size(), 1);
    EXPECT_EQ(graph.nodes[1]->accesses[0]->mode, Mode::READ);
    EXPECT_TRUE(HasEdge(graph, 1, 2, Reason::WRITE_AFTER_READ));
    EXPECT_TRUE(HasEdge(graph, 2, 3, Reason::READ_AFTER_WRITE));
    EXPECT_TRUE(HasEdge(graph, 2, 4, Reason::READ_AFTER_WRITE));
    Serialize(graph);
}

TEST(PlannerTest, VisualizationSelectIntoHasNoBackendSql) {
    Catalog catalog;
    auto schema = Analyze(catalog, "create table a (id int)", true);
    auto script = Analyze(catalog, "select * into target from a visualize using table ()");
    ASSERT_TRUE(script->GetParsedScript()->errors.empty());
    auto graph = Plan(*script);
    EXPECT_FALSE(graph.valid);
    ASSERT_EQ(graph.nodes.size(), 1);
    EXPECT_TRUE(graph.nodes[0]->barrier);
    EXPECT_TRUE(graph.nodes[0]->sql.empty());
    EXPECT_TRUE(HasDiagnostic(graph, "VISUALIZE SELECT INTO"));
}

TEST(PlannerTest, VisualizationMetadataIsPerStatementAndRoundTripsWithoutMutatingNativeState) {
    Catalog catalog;
    auto schema = Analyze(catalog, "create table embeddings (embedding int, cluster_id int, label text)", true);
    auto script = Analyze(catalog,
        "select 1; "
        "select 2 as value visualize using vegalite (mark => bar, encoding => (x => (field => value))); "
        "select embedding, cluster_id, label from embeddings visualize using umap "
        "(vector => embedding, category => cluster_id, label => label, neighbors => 15, min_dist => 0.1, metric => cosine); "
        "select 'item' as product visualize using markdown (template => '## {{product}}'); "
        "select 5 visualize using table (dashboard => (row => 2, column => 4, width => 8, height => 5)); "
        "select 6");
    ASSERT_TRUE(script->GetParsedScript()->errors.empty());
    auto analyzed = script->GetAnalyzedScript();
    auto version = catalog.GetVersion();
    auto text_version = script->text_version;
    analyzed->visualization_specs.ForEach([&](size_t, const VisualizationSpec& spec) {
        EXPECT_EQ(spec.umap_model, nullptr);
        EXPECT_EQ(spec.markdown_ast, nullptr);
    });
    auto graph = Plan(*script);
    ASSERT_TRUE(graph.valid);
    ASSERT_EQ(graph.nodes.size(), 6);
    EXPECT_EQ(graph.nodes[0]->visualization, nullptr);
    EXPECT_EQ(graph.nodes[5]->visualization, nullptr);
    for (auto index : {1, 2, 3, 4}) {
        ASSERT_NE(graph.nodes[index]->visualization, nullptr);
        EXPECT_EQ(graph.nodes[index]->statement_id, index);
        EXPECT_TRUE(graph.nodes[index]->produces_output);
        EXPECT_FALSE(graph.nodes[index]->barrier);
        EXPECT_EQ(graph.nodes[index]->sql.find("visualize"), std::string::npos);
    }
    EXPECT_EQ(graph.nodes[2]->sql, "select embedding, cluster_id, label from embeddings");
    ASSERT_EQ(graph.nodes[2]->accesses.size(), 1);
    EXPECT_EQ(graph.nodes[2]->accesses[0]->mode, Mode::READ);
    auto bytes = Serialize(graph);
    auto unpacked = std::unique_ptr<ExecutionGraphT>{flatbuffers::GetRoot<ExecutionGraph>(bytes.data())->UnPack()};
    auto& vega = *unpacked->nodes[1]->visualization;
    EXPECT_EQ(vega.renderer, "vegalite");
    EXPECT_NE(vega.vegalite_spec.find("\"bar\""), std::string::npos);
    EXPECT_NE(vega.vegalite_spec.find("\"value\""), std::string::npos);
    auto& umap = *unpacked->nodes[2]->visualization;
    EXPECT_EQ(umap.renderer, "umap");
    ASSERT_NE(umap.umap_spec, nullptr);
    EXPECT_EQ(umap.umap_spec->vector_column, "embedding");
    EXPECT_EQ(umap.umap_spec->category_column, "cluster_id");
    EXPECT_EQ(umap.umap_spec->label_column, "label");
    ASSERT_NE(umap.umap_spec->projection, nullptr);
    EXPECT_EQ(umap.umap_spec->projection->method, buffers::visualization::UmapProjectionMethod::UMAP);
    EXPECT_EQ(umap.umap_spec->projection->metric, "cosine");
    EXPECT_EQ(umap.umap_spec->projection->neighbors, 15);
    ASSERT_TRUE(umap.umap_spec->projection->min_dist.has_value());
    EXPECT_DOUBLE_EQ(*umap.umap_spec->projection->min_dist, 0.1);
    auto& markdown = *unpacked->nodes[3]->visualization;
    EXPECT_EQ(markdown.renderer, "markdown");
    ASSERT_NE(markdown.markdown_spec, nullptr);
    EXPECT_EQ(markdown.markdown_spec->template_, "## {{product}}");
    EXPECT_EQ(markdown.markdown_spec->fields, (std::vector<std::string>{"product"}));
    ASSERT_NE(markdown.markdown_spec->document, nullptr);
    ASSERT_EQ(markdown.markdown_spec->document->children.size(), 1);
    EXPECT_EQ(markdown.markdown_spec->document->children[0]->node_type,
              buffers::visualization::MarkdownNodeType::HEADING);
    auto& table = *unpacked->nodes[4]->visualization;
    EXPECT_EQ(table.renderer, "table");
    ASSERT_NE(table.table_spec, nullptr);
    ASSERT_NE(table.dashboard, nullptr);
    EXPECT_EQ(table.dashboard->row, 2);
    EXPECT_EQ(table.dashboard->column, 4);
    EXPECT_EQ(table.dashboard->width, 8);
    EXPECT_EQ(table.dashboard->height, 5);
    ASSERT_NE(vega.dashboard, nullptr);
    EXPECT_FALSE(vega.dashboard->row.has_value());
    EXPECT_FALSE(vega.dashboard->column.has_value());
    EXPECT_EQ(vega.dashboard->width, 6);
    EXPECT_EQ(vega.dashboard->height, 3);
    EXPECT_EQ(bytes, Serialize(Plan(*script)));
    EXPECT_EQ(bytes, Serialize(*unpacked));
    EXPECT_EQ(script->GetAnalyzedScript(), analyzed);
    EXPECT_EQ(script->text_version, text_version);
    EXPECT_EQ(catalog.GetVersion(), version);
    analyzed->visualization_specs.ForEach([&](size_t, const VisualizationSpec& spec) {
        EXPECT_EQ(spec.umap_model != nullptr, spec.renderer == std::string_view{"umap"});
        EXPECT_EQ(spec.markdown_ast != nullptr, spec.renderer == std::string_view{"markdown"});
    });
}

TEST(PlannerTest, RendererCaseNormalizationCompilesMetadataWithoutMutatingNativeState) {
    Catalog catalog;
    auto schema = Analyze(catalog, "create table embeddings (embedding int, label text)", true);
    struct Case {
        std::string_view renderer;
        std::string_view normalized;
        std::string_view options;
    };
    for (auto test : {Case{"TABLE", "table", "()"}, Case{"TaBlE", "table", "()"},
                      Case{"VEGALITE", "vegalite", "(mark => bar)"},
                      Case{"VeGaLiTe", "vegalite", "(mark => bar)"},
                      Case{"UMAP", "umap", "(vector => embedding, label => label)"},
                      Case{"UmAp", "umap", "(vector => embedding, label => label)"},
                      Case{"MARKDOWN", "markdown", "(template => '## {{label}}')"},
                      Case{"MaRkDoWn", "markdown", "(template => '## {{label}}')"}}) {
        SCOPED_TRACE(test.renderer);
        auto sql = "select embedding, label from embeddings visualize using " + std::string{test.renderer} +
                   " " + std::string{test.options};
        auto script = Analyze(catalog, sql);
        ASSERT_TRUE(script->GetParsedScript()->errors.empty());
        auto analyzed = script->GetAnalyzedScript();
        auto parsed = script->GetParsedScript();
        auto version = catalog.GetVersion();
        auto text_version = script->text_version;
        ASSERT_EQ(analyzed->visualization_specs.GetSize(), 1);
        auto check_analysis = [&] {
            analyzed->visualization_specs.ForEach([&](size_t, const VisualizationSpec& spec) {
                ASSERT_TRUE(spec.renderer.has_value());
                EXPECT_EQ(*spec.renderer, test.renderer);
            });
        };
        check_analysis();
        auto graph = Plan(*script);
        ASSERT_TRUE(graph.valid);
        EXPECT_TRUE(graph.diagnostics.empty());
        EXPECT_TRUE(graph.edges.empty());
        ASSERT_EQ(graph.nodes.size(), 1);
        auto& node = *graph.nodes[0];
        EXPECT_EQ(node.statement_type, buffers::parser::StatementType::VIS_VISUALISE);
        EXPECT_TRUE(node.produces_output);
        EXPECT_FALSE(node.barrier);
        EXPECT_EQ(node.sql, "select embedding, label from embeddings");
        ASSERT_EQ(node.accesses.size(), 1);
        EXPECT_EQ(node.accesses[0]->mode, Mode::READ);
        ASSERT_NE(node.visualization, nullptr);
        auto& visualization = *node.visualization;
        EXPECT_EQ(visualization.renderer, test.normalized);
        if (test.normalized == "table") ASSERT_NE(visualization.table_spec, nullptr);
        if (test.normalized == "vegalite") EXPECT_NE(visualization.vegalite_spec.find("\"bar\""), std::string::npos);
        if (test.normalized == "umap") {
            ASSERT_NE(visualization.umap_spec, nullptr);
            EXPECT_EQ(visualization.umap_spec->vector_column, "embedding");
            EXPECT_EQ(visualization.umap_spec->label_column, "label");
        }
        if (test.normalized == "markdown") {
            ASSERT_NE(visualization.markdown_spec, nullptr);
            EXPECT_EQ(visualization.markdown_spec->template_, "## {{label}}");
            EXPECT_EQ(visualization.markdown_spec->fields, (std::vector<std::string>{"label"}));
            ASSERT_NE(visualization.markdown_spec->document, nullptr);
        }
        auto bytes = Serialize(graph);
        EXPECT_EQ(bytes, Serialize(Plan(*script)));
        EXPECT_EQ(script->ToString(), sql);
        EXPECT_EQ(script->text_version, text_version);
        EXPECT_EQ(script->GetParsedScript(), parsed);
        EXPECT_EQ(script->GetAnalyzedScript(), analyzed);
        EXPECT_EQ(catalog.GetVersion(), version);
        check_analysis();
    }
}

TEST(PlannerTest, InvalidVisualizationMetadataRejectsTheOwningNodeBeforeBackendExecution) {
    Catalog catalog;
    for (auto renderer : {"missing", "unsupported", "umap"}) {
        SCOPED_TRACE(renderer);
        auto script = Analyze(catalog, renderer == std::string_view{"umap"}
            ? "select 1; select 2 visualize using umap (); select 3"
            : "select 1; select 2 visualize using table (); select 3");
        ASSERT_TRUE(script->GetParsedScript()->errors.empty());
        script->GetAnalyzedScript()->visualization_specs.ForEach([&](size_t, VisualizationSpec& spec) {
            if (renderer == std::string_view{"missing"}) spec.renderer.reset();
            if (renderer == std::string_view{"unsupported"}) spec.renderer = "unsupported";
        });
        auto graph = Plan(*script);
        EXPECT_FALSE(graph.valid);
        ASSERT_EQ(graph.nodes.size(), 3);
        EXPECT_EQ(graph.nodes[0]->sql, "select 1");
        EXPECT_EQ(graph.nodes[2]->sql, "select 3");
        EXPECT_TRUE(graph.nodes[1]->barrier);
        EXPECT_TRUE(graph.nodes[1]->sql.empty());
        EXPECT_EQ(graph.nodes[1]->visualization, nullptr);
        ASSERT_EQ(graph.diagnostics.size(), 1);
        EXPECT_EQ(graph.diagnostics[0]->node, 1);
        EXPECT_TRUE(HasDiagnostic(graph, "visualization:"));
        EXPECT_TRUE(HasEdge(graph, 0, 1, Reason::BARRIER));
        EXPECT_TRUE(HasEdge(graph, 1, 2, Reason::BARRIER));
        Serialize(graph);
    }
}

TEST(PlannerTest, IdentifierCaseNormalizationPreservesQuotedNames) {
    Catalog catalog;
    auto schema = Analyze(catalog, "create table Mixed (id int); create table \"Mixed\" (id int)", true);
    auto script = Analyze(catalog, "select * from MIXED; insert into mixed values (1); select * from \"Mixed\"");
    auto graph = Plan(*script);
    ASSERT_TRUE(graph.valid);
    ASSERT_EQ(graph.entities.size(), 2);
    EXPECT_EQ(graph.entities[0]->name, "mixed");
    EXPECT_EQ(graph.entities[1]->name, "Mixed");
    EXPECT_TRUE(graph.entities[0]->database_name.empty());
    EXPECT_TRUE(graph.entities[0]->schema_name.empty());
    EXPECT_TRUE(HasEdge(graph, 0, 1, Reason::WRITE_AFTER_READ));
    EXPECT_EQ(graph.edges.size(), 1);
}

TEST(PlannerTest, ViewWritesAreBarriersAgainstBaseReadsAndWrites) {
    Catalog catalog;
    auto schema = Analyze(catalog, "create table base (id int); create view v as select * from base", true);
    auto script = Analyze(catalog,
        "select * from base; insert into base values (1); insert into v values (2); "
        "select * from base; insert into base values (3)");
    auto graph = Plan(*script);
    ASSERT_TRUE(graph.valid);
    ASSERT_EQ(graph.nodes.size(), 5);
    EXPECT_TRUE(graph.nodes[2]->barrier);
    EXPECT_TRUE(HasDiagnostic(graph, "view dependencies"));
    EXPECT_TRUE(HasEdge(graph, 0, 2, Reason::BARRIER));
    EXPECT_TRUE(HasEdge(graph, 1, 2, Reason::BARRIER));
    EXPECT_TRUE(HasEdge(graph, 2, 3, Reason::BARRIER));
    EXPECT_TRUE(HasEdge(graph, 2, 4, Reason::BARRIER));
}

TEST(PlannerTest, CatalogChangesInvalidatePreviouslyAnalyzedInputs) {
    Catalog catalog;
    auto script = Analyze(catalog, "select * from a");
    auto snapshot = script->GetAnalyzedScript();
    auto schema = Analyze(catalog, "create table a (id int)", true);
    ASSERT_NE(snapshot->GetCatalogVersion(), catalog.GetVersion());
    auto graph = Plan(*script);
    EXPECT_FALSE(graph.valid);
    EXPECT_TRUE(graph.nodes.empty());
    EXPECT_TRUE(HasDiagnostic(graph, "stale catalog analysis"));
    EXPECT_EQ(script->GetAnalyzedScript(), snapshot);
    script->Analyze(false);
    graph = Plan(*script);
    ASSERT_TRUE(graph.valid);
    ASSERT_EQ(graph.nodes.size(), 1);
    EXPECT_FALSE(graph.nodes[0]->barrier);
    auto revision = graph.scripts[0]->analyzed_catalog_revision;
    catalog.DropScript(*schema);
    EXPECT_LT(revision, catalog.GetVersion());
    graph = Plan(*script);
    EXPECT_FALSE(graph.valid);
    EXPECT_TRUE(HasDiagnostic(graph, "stale catalog analysis"));
}

TEST(PlannerTest, AllPublishedInputsCanBeRefreshedWithoutTextChangesOrPublication) {
    Catalog catalog;
    auto producer = Analyze(catalog, "create table a (id int)", true);
    auto consumer = Analyze(catalog, "select * from a", true);
    std::array inputs{PlannerInput{producer.get()}, PlannerInput{consumer.get()}};
    EXPECT_FALSE(Planner::Plan(inputs).valid);
    auto producer_text_version = producer->text_version;
    auto consumer_text_version = consumer->text_version;
    auto version = catalog.GetVersion();
    producer->Analyze(false);
    consumer->Analyze(false);
    auto graph = Planner::Plan(inputs);
    ASSERT_TRUE(graph.valid);
    EXPECT_TRUE(HasEdge(graph, 0, 1, Reason::DDL));
    EXPECT_EQ(producer->text_version, producer_text_version);
    EXPECT_EQ(consumer->text_version, consumer_text_version);
    ASSERT_EQ(graph.scripts.size(), 2);
    EXPECT_EQ(graph.scripts[0]->analyzed_catalog_revision, version);
    EXPECT_EQ(graph.scripts[1]->analyzed_catalog_revision, version);
    auto bytes = Serialize(graph);
    auto* packed = flatbuffers::GetRoot<ExecutionGraph>(bytes.data());
    ASSERT_EQ(packed->entities()->size(), 1);
    ASSERT_NE(packed->entities()->Get(0)->catalog_object_id(), nullptr);
    EXPECT_EQ(packed->entities()->Get(0)->catalog_object_id()->object_type(), ExecutionGraphEntityType::TABLE);
    EXPECT_EQ(packed->entities()->Get(0)->catalog_object_id()->object_id(),
              producer->GetAnalyzedScript()->GetTables()[0].GetTableID().Pack());
    EXPECT_EQ(packed->scripts()->Get(0)->analyzed_catalog_revision(), version);
    EXPECT_EQ(packed->scripts()->Get(1)->analyzed_catalog_revision(), version);
    EXPECT_EQ(catalog.GetVersion(), version);
}

TEST(PlannerTest, QualifiedReferencesBoundAsCtesRemainPhysicalReads) {
    Catalog catalog;
    auto schema = Analyze(catalog, "create table s.c (id int); create table db.s.c (id int)", true);
    auto script = Analyze(catalog,
        "with c as (select 1 as id) select * from s.c; insert into s.c values (2); "
        "with c as (select 1 as id) select * from db.s.c; insert into db.s.c values (3)");
    auto graph = Plan(*script);
    ASSERT_TRUE(graph.valid);
    ASSERT_EQ(graph.nodes.size(), 4);
    ASSERT_EQ(graph.entities.size(), 2);
    ASSERT_EQ(graph.unresolved_references.size(), 2);
    EXPECT_TRUE(graph.nodes[0]->barrier);
    EXPECT_TRUE(graph.nodes[2]->barrier);
    EXPECT_TRUE(HasDiagnostic(graph, "unresolved relation"));
    ASSERT_EQ(graph.nodes[0]->accesses.size(), 1);
    EXPECT_EQ(graph.nodes[0]->accesses[0]->mode, Mode::READ);
    EXPECT_EQ(graph.unresolved_references[0]->schema_name, "s");
    EXPECT_EQ(graph.unresolved_references[1]->database_name, "db");
    EXPECT_TRUE(HasEdge(graph, 0, 1, Reason::WRITE_AFTER_READ));
    EXPECT_TRUE(HasEdge(graph, 2, 3, Reason::WRITE_AFTER_READ));
}

TEST(PlannerTest, DropPrefersEarlierDefaultProducerOverFutureScopedDeclaration) {
    Catalog catalog;
    auto first = Analyze(catalog, "create table a (id int); select * from a", true);
    auto second = Analyze(catalog, "drop table a; create table s.a (id int)", true);
    first->Analyze(false);
    second->Analyze(false);
    std::array inputs{PlannerInput{first.get()}, PlannerInput{second.get()}};
    auto graph = Planner::Plan(inputs);
    ASSERT_TRUE(graph.valid);
    ASSERT_EQ(graph.entities.size(), 2);
    ASSERT_EQ(graph.nodes.size(), 4);
    ASSERT_EQ(graph.nodes[2]->accesses.size(), 1);
    EXPECT_EQ(graph.nodes[2]->accesses[0]->entity, graph.nodes[0]->accesses[0]->entity);
    EXPECT_TRUE(graph.entities[0]->schema_name.empty());
    EXPECT_EQ(graph.entities[1]->schema_name, "s");
    EXPECT_TRUE(HasEdge(graph, 0, 2, Reason::DDL));
    EXPECT_TRUE(HasEdge(graph, 1, 2, Reason::DDL));
    EXPECT_FALSE(HasEdge(graph, 2, 3, Reason::DDL));
}

TEST(PlannerTest, DropUsesExternalNamespaceInsteadOfFutureParticipatingDeclarations) {
    Catalog catalog;
    auto schema = Analyze(catalog, "create table db.s.a (id int)", true);
    auto script = Analyze(catalog, "select * from db.s.a; drop table a; create table future.a (id int)", true);
    auto graph = Plan(*script);
    ASSERT_TRUE(graph.valid);
    ASSERT_EQ(graph.entities.size(), 2);
    ASSERT_EQ(graph.nodes[1]->accesses.size(), 1);
    EXPECT_EQ(graph.nodes[1]->accesses[0]->entity, graph.nodes[0]->accesses[0]->entity);
    EXPECT_TRUE(HasEdge(graph, 0, 1, Reason::DDL));
    EXPECT_FALSE(HasEdge(graph, 1, 2, Reason::DDL));
}

TEST(PlannerTest, DropSuffixUsesEarlierScopedProducerNotFutureDeclaration) {
    Catalog catalog;
    auto first = Analyze(catalog, "create table db.s.a (id int); select * from db.s.a");
    auto second = Analyze(catalog, "drop table s.a; create table future.s.a (id int)");
    std::array inputs{PlannerInput{first.get()}, PlannerInput{second.get()}};
    auto graph = Planner::Plan(inputs);
    ASSERT_TRUE(graph.valid);
    ASSERT_EQ(graph.nodes[2]->accesses.size(), 1);
    EXPECT_EQ(graph.nodes[2]->accesses[0]->entity, graph.nodes[0]->accesses[0]->entity);
    EXPECT_TRUE(HasEdge(graph, 0, 2, Reason::DDL));
    EXPECT_TRUE(HasEdge(graph, 1, 2, Reason::DDL));
    EXPECT_FALSE(HasEdge(graph, 2, 3, Reason::DDL));
}

TEST(PlannerTest, DropRejectsAmbiguousLiveNamespaceButHonorsExactScopedTargets) {
    Catalog catalog;
    auto schema = Analyze(catalog, "create table db1.s.a (id int); create table db2.s.a (id int)", true);
    auto first = Analyze(catalog, "create table other.a (id int)");
    auto second = Analyze(catalog, "drop table a; create table future.a (id int)");
    std::array inputs{PlannerInput{first.get()}, PlannerInput{second.get()}};
    auto graph = Planner::Plan(inputs);
    EXPECT_FALSE(graph.valid);
    EXPECT_TRUE(HasDiagnostic(graph, "ambiguous DROP"));
    auto scoped = Analyze(catalog, "select * from db1.s.a; drop table db1.s.a; create table s.a (id int)");
    graph = Plan(*scoped);
    ASSERT_TRUE(graph.valid);
    EXPECT_TRUE(HasEdge(graph, 0, 1, Reason::DDL));
    EXPECT_FALSE(HasEdge(graph, 1, 2, Reason::DDL));
}

TEST(PlannerTest, DroppingPublishedViewsOrdersBaseDropsConservatively) {
    Catalog catalog;
    auto schema = Analyze(catalog, "create table base (id int); create view v as select * from base", true);
    for (auto sql : {"select 1; drop view v; drop table base", "select 1; drop table v; drop table base"}) {
        auto script = Analyze(catalog, sql);
        auto graph = Plan(*script);
        ASSERT_TRUE(graph.valid);
        ASSERT_EQ(graph.nodes.size(), 3);
        EXPECT_TRUE(graph.nodes[1]->barrier);
        EXPECT_TRUE(HasDiagnostic(graph, "view dependencies"));
        EXPECT_TRUE(HasEdge(graph, 0, 1, Reason::BARRIER));
        EXPECT_TRUE(HasEdge(graph, 1, 2, Reason::BARRIER));
        ASSERT_EQ(graph.nodes[1]->accesses.size(), 1);
        EXPECT_EQ(graph.nodes[1]->accesses[0]->mode, Mode::DDL);
        EXPECT_EQ(graph.entities[graph.nodes[1]->accesses[0]->entity]->name, "v");
        Serialize(graph);
    }
}

TEST(PlannerTest, ReusedDeclarationIdCannotRedirectPublishedReferenceToRenamedInput) {
    Catalog catalog;
    auto producer = Analyze(catalog, "create table s.old (id int)", true);
    auto published = producer->GetAnalyzedScript();
    producer->ReplaceText("create table s.new (id int)");
    producer->Analyze();
    auto consumer = Analyze(catalog, "select * from s.old");
    ASSERT_EQ(published->GetTables()[0].object_id, producer->GetAnalyzedScript()->GetTables()[0].object_id);
    ASSERT_EQ(producer->GetAnalyzedScript()->GetCatalogVersion(), catalog.GetVersion());
    ASSERT_EQ(consumer->GetAnalyzedScript()->GetCatalogVersion(), catalog.GetVersion());
    std::array inputs{PlannerInput{producer.get()}, PlannerInput{consumer.get()}};
    auto graph = Planner::Plan(inputs);
    EXPECT_FALSE(graph.valid);
    EXPECT_TRUE(HasDiagnostic(graph, "resolved relation declaration is incompatible or unavailable"));
    ASSERT_EQ(graph.nodes.size(), 2);
    EXPECT_TRUE(graph.nodes[1]->barrier);
    ASSERT_EQ(graph.nodes[1]->accesses.size(), 1);
    EXPECT_EQ(graph.nodes[1]->accesses[0]->entity, UINT32_MAX);
    ASSERT_EQ(graph.unresolved_references.size(), 1);
    EXPECT_EQ(graph.unresolved_references[0]->schema_name, "s");
    EXPECT_EQ(graph.unresolved_references[0]->name, "old");
    Serialize(graph);
}

TEST(PlannerTest, ReusedDeclarationIdRejectsPublishedTableViewKindChanges) {
    for (bool published_view : {false, true}) {
        Catalog catalog;
        auto producer = Analyze(catalog, published_view ? "create view s.a as select 1 as id"
                                                       : "create table s.a (id int)", true);
        producer->ReplaceText(published_view ? "create table s.a (id int)" : "create view s.a as select 1 as id");
        producer->Analyze();
        auto consumer = Analyze(catalog, "select * from s.a");
        std::array inputs{PlannerInput{producer.get()}, PlannerInput{consumer.get()}};
        auto graph = Planner::Plan(inputs);
        EXPECT_FALSE(graph.valid);
        EXPECT_TRUE(HasDiagnostic(graph, "resolved relation declaration is incompatible or unavailable"));
        ASSERT_EQ(graph.nodes[1]->accesses.size(), 1);
        EXPECT_EQ(graph.nodes[1]->accesses[0]->entity, UINT32_MAX);
        ASSERT_EQ(graph.unresolved_references.size(), 1);
        EXPECT_EQ(graph.unresolved_references[0]->name, "a");
        Serialize(graph);
    }
}

}  // namespace
