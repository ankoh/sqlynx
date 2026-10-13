#include "dashql/script.h"

#include "dashql/catalog.h"
#include "gtest/gtest.h"

using namespace dashql;

namespace {

struct AnalyzerDeleteTest : public ::testing::Test {
    Catalog catalog;
    Script schema{catalog};
    Script script{catalog};

    void SetUp() override {
        schema.InsertTextAt(0, "create table target (id int, label text); "
                              "create table source (id int, source_only text); "
                              "create table audit (id int);");
        schema.Analyze();
        catalog.LoadScript(schema, 0);
    }

    std::shared_ptr<AnalyzedScript> Analyze(std::string_view sql) {
        script.InsertTextAt(0, sql);
        script.Analyze();
        EXPECT_TRUE(script.GetParsedScript()->errors.empty());
        return script.GetAnalyzedScript();
    }
};

TEST_F(AnalyzerDeleteTest, ResolvesWriteTargetAndUsingReads) {
    auto analyzed = Analyze("delete from target as t using source as s "
                            "where t.id = s.id returning t.label, s.source_only");
    ASSERT_EQ(analyzed->table_references.GetSize(), 2u);
    analyzed->table_references.ForEach([&](size_t, const TableReference& reference) {
        auto* relation = std::get_if<TableReference::RelationExpression>(&reference.inner);
        ASSERT_NE(relation, nullptr);
        EXPECT_EQ(reference.role, relation->table_name.table_name.get().text == "target"
                                      ? TableReference::Role::Write : TableReference::Role::Read);
        EXPECT_TRUE(relation->resolved_table.has_value());
        EXPECT_EQ(reference.ast_statement_id, 0u);
    });
    ASSERT_EQ(analyzed->expressions.GetSize(), 4u);
    analyzed->expressions.ForEach([&](size_t, const Expression& expression) {
        auto* column = std::get_if<Expression::ColumnRef>(&expression.inner);
        ASSERT_NE(column, nullptr);
        EXPECT_TRUE(column->IsResolved()) << column->column_name.column_name.get().text;
    });

    flatbuffers::FlatBufferBuilder builder;
    builder.Finish(analyzed->Pack(builder));
    auto* packed = flatbuffers::GetRoot<buffers::analyzer::AnalyzedScript>(builder.GetBufferPointer());
    ASSERT_EQ(packed->table_references()->size(), 2u);
    for (size_t i = 0; i < 2; ++i) {
        EXPECT_EQ(packed->table_references()->Get(i)->role(),
                  analyzed->table_references[i].role == TableReference::Role::Write
                      ? buffers::analyzer::TableReferenceRole::WRITE : buffers::analyzer::TableReferenceRole::READ);
    }
}

TEST_F(AnalyzerDeleteTest, ResolvesCorrelatedWhereAndReturningSubqueries) {
    auto analyzed = Analyze("delete from target t using source s "
                            "where exists (select 1 from audit a where a.id = t.id) "
                            "returning (select a.id from audit a where a.id = s.id) as deleted_id");
    ASSERT_EQ(analyzed->table_references.GetSize(), 4u);
    size_t writes = 0;
    analyzed->table_references.ForEach([&](size_t, const TableReference& reference) {
        if (reference.role == TableReference::Role::Write) ++writes;
    });
    EXPECT_EQ(writes, 1u);
    size_t columns = 0;
    analyzed->expressions.ForEach([&](size_t, const Expression& expression) {
        auto* column = std::get_if<Expression::ColumnRef>(&expression.inner);
        if (!column) return;
        ++columns;
        EXPECT_TRUE(column->IsResolved()) << column->column_name.column_name.get().text;
    });
    EXPECT_EQ(columns, 5u);
}

TEST_F(AnalyzerDeleteTest, LeadingCtesResolveInOrderButCannotSeeDeleteRelations) {
    auto analyzed = Analyze("with first as (select id from source), "
                            "second as (select id from first), "
                            "isolated as (select label) "
                            "delete from target t using second s where t.id = s.id returning t.id");
    ASSERT_EQ(analyzed->table_references.GetSize(), 4u);
    analyzed->expressions.ForEach([&](size_t, const Expression& expression) {
        auto* column = std::get_if<Expression::ColumnRef>(&expression.inner);
        ASSERT_NE(column, nullptr);
        EXPECT_EQ(column->IsResolved(), column->column_name.column_name.get().text != "label");
    });
}

TEST_F(AnalyzerDeleteTest, CteDoesNotShadowWriteTarget) {
    auto analyzed = Analyze("with target as (select 1 as cte_only) "
                            "delete from target t using target s where t.id = s.cte_only returning t.label");
    ASSERT_EQ(analyzed->table_references.GetSize(), 2u);
    analyzed->table_references.ForEach([&](size_t, const TableReference& reference) {
        if (reference.role != TableReference::Role::Write) return;
        auto* target = std::get_if<TableReference::RelationExpression>(&reference.inner);
        ASSERT_NE(target, nullptr);
        EXPECT_TRUE(target->resolved_table.has_value());
    });
    analyzed->expressions.ForEach([&](size_t, const Expression& expression) {
        auto* column = std::get_if<Expression::ColumnRef>(&expression.inner);
        if (!column) return;
        EXPECT_TRUE(column->IsResolved());
    });
}

TEST_F(AnalyzerDeleteTest, NonRecursiveCtesDoNotResolveSelfOrForwardReferences) {
    auto analyzed = Analyze("with first as (select * from later), later as (select * from later) "
                            "delete from target using first");
    size_t unresolved_reads = 0;
    analyzed->name_scopes.ForEach([&](size_t, const NameScope& scope) {
        for (auto& [_, table] : scope.referenced_tables_by_name) {
            if (table.IsUnresolvedRelation()) ++unresolved_reads;
        }
    });
    EXPECT_EQ(unresolved_reads, 2u);
}

TEST_F(AnalyzerDeleteTest, RecursiveCteAndUsingJoinResolveColumns) {
    auto analyzed = Analyze("with recursive ids as (select 1 as id union all "
                            "select id + 1 from ids where id < 3) "
                            "delete from target t using ids i join source s on i.id = s.id "
                            "where t.id = i.id returning t.label");
    analyzed->expressions.ForEach([&](size_t, const Expression& expression) {
        auto* column = std::get_if<Expression::ColumnRef>(&expression.inner);
        if (!column) return;
        EXPECT_TRUE(column->IsResolved()) << column->column_name.column_name.get().text;
    });
}

TEST_F(AnalyzerDeleteTest, InnerAliasesShadowTargetDuringCorrelation) {
    auto analyzed = Analyze("delete from target t where exists "
                            "(select 1 from source t where t.source_only = 'x') returning t.label");
    analyzed->expressions.ForEach([&](size_t, const Expression& expression) {
        auto* column = std::get_if<Expression::ColumnRef>(&expression.inner);
        if (!column) return;
        EXPECT_TRUE(column->IsResolved());
    });
}

TEST_F(AnalyzerDeleteTest, ChildOutputsDoNotLeakIntoDeleteScope) {
    auto analyzed = Analyze("delete from target t "
                            "where exists (select 1 as subquery_only) returning subquery_only, target.id");
    size_t unresolved_columns = 0;
    analyzed->expressions.ForEach([&](size_t, const Expression& expression) {
        auto* column = std::get_if<Expression::ColumnRef>(&expression.inner);
        if (!column) return;
        if (!column->IsResolved()) ++unresolved_columns;
    });
    EXPECT_EQ(unresolved_columns, 2u);
}

TEST_F(AnalyzerDeleteTest, UnresolvedTargetRemainsWriteAndStatementsAreIsolated) {
    auto analyzed = Analyze("delete from missing m where m.id = 1 returning m.id; "
                            "delete from target where m.id = 2 returning id");
    ASSERT_EQ(analyzed->table_references.GetSize(), 2u);
    EXPECT_EQ(analyzed->table_references[0].role, TableReference::Role::Write);
    EXPECT_EQ(analyzed->table_references[1].role, TableReference::Role::Write);
    EXPECT_EQ(analyzed->table_references[0].ast_statement_id, 0u);
    EXPECT_EQ(analyzed->table_references[1].ast_statement_id, 1u);
    auto* missing = std::get_if<TableReference::RelationExpression>(&analyzed->table_references[0].inner);
    ASSERT_NE(missing, nullptr);
    EXPECT_FALSE(missing->resolved_table.has_value());
    auto* last = std::get_if<Expression::ColumnRef>(&analyzed->expressions[3].inner);
    ASSERT_NE(last, nullptr);
    EXPECT_TRUE(last->IsResolved());
}

}  // namespace
