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
    for (auto sql : {"set foo = 1", "attach database 'test.db' as db", "explain select 1",
                     "create function f() returns int", "select 1 visualize using table", "create temp table t (id int)",
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

TEST(PlannerTest, UnsupportedVisualizationHasNoBackendSql) {
    Catalog catalog;
    auto script = Analyze(catalog, "select 1 as id visualize using table ()");
    auto graph = Plan(*script);
    EXPECT_FALSE(graph.valid);
    ASSERT_EQ(graph.nodes.size(), 1);
    EXPECT_TRUE(graph.nodes[0]->barrier);
    EXPECT_TRUE(graph.nodes[0]->sql.empty());
    EXPECT_TRUE(HasDiagnostic(graph, "unsupported statement"));
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
