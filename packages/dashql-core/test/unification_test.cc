#include "gtest/gtest.h"
#include "dashql/catalog.h"
#include "dashql/external.h"
#include "dashql/proto/proto_generated.h"
#include "dashql/script.h"

using namespace dashql;

namespace {

TEST(UnificationTest, EmptyCatalogHasNoSchema) {
    Catalog catalog;

    flatbuffers::FlatBufferBuilder fb;
    fb.Finish(catalog.Flatten(fb));
    auto flat = flatbuffers::GetRoot<proto::FlatCatalog>(fb.GetBufferPointer());
    EXPECT_EQ(flat->databases()->size(), 0);
    EXPECT_EQ(flat->schemas()->size(), 0);
}

TEST(UnificationTest, SingleTableInDefaultSchema) {
    Catalog catalog;

    Script script{catalog, 42};
    script.InsertTextAt(0, "create table foo(a int);");

    ASSERT_EQ(script.Scan().second, proto::StatusCode::OK);
    ASSERT_EQ(script.Parse().second, proto::StatusCode::OK);
    ASSERT_EQ(script.Analyze().second, proto::StatusCode::OK);
    ASSERT_EQ(catalog.LoadScript(script, 1), proto::StatusCode::OK);

    flatbuffers::FlatBufferBuilder fb;
    fb.Finish(catalog.Flatten(fb));
    auto flat = flatbuffers::GetRoot<proto::FlatCatalog>(fb.GetBufferPointer());

    // "foo" should get expanded to dashql.default.foo
    // The flat catalog should therefore have exactly 1 database, 1 schema, 1 table, 1 column
    ASSERT_EQ(flat->databases()->size(), 1);
    ASSERT_EQ(flat->schemas()->size(), 1);
    ASSERT_EQ(flat->tables()->size(), 1);
    ASSERT_EQ(flat->columns()->size(), 1);
    ASSERT_EQ(flat->databases()->Get(0)->catalog_object_id(), INITIAL_DATABASE_ID);
    ASSERT_EQ(flat->schemas()->Get(0)->catalog_object_id(), INITIAL_SCHEMA_ID);
    ASSERT_EQ(flat->tables()->Get(0)->catalog_object_id(), ContextObjectID(42, 0).Pack());

    // Check names
    EXPECT_EQ(flat->name_dictionary()->size(), 4);
    EXPECT_EQ(flat->name_dictionary()->Get(flat->databases()->Get(0)->name_id())->string_view(),
              Catalog::DEFAULT_DATABASE_NAME);
    EXPECT_EQ(flat->name_dictionary()->Get(flat->schemas()->Get(0)->name_id())->string_view(),
              Catalog::DEFAULT_SCHEMA_NAME);
    EXPECT_EQ(flat->name_dictionary()->Get(flat->tables()->Get(0)->name_id())->string_view(), "foo");
    EXPECT_EQ(flat->name_dictionary()->Get(flat->columns()->Get(0)->name_id())->string_view(), "a");
}

TEST(UnificationTest, MultipleTablesInDefaultSchema) {
    Catalog catalog;

    Script schema0{catalog, 42};
    Script schema1{catalog, 100};
    schema0.InsertTextAt(0, "create table foo(a int);");
    schema1.InsertTextAt(0, "create table bar(a int);");

    ASSERT_EQ(schema0.Scan().second, proto::StatusCode::OK);
    ASSERT_EQ(schema0.Parse().second, proto::StatusCode::OK);
    ASSERT_EQ(schema0.Analyze().second, proto::StatusCode::OK);
    ASSERT_EQ(catalog.LoadScript(schema0, 1), proto::StatusCode::OK);

    ASSERT_EQ(schema1.Scan().second, proto::StatusCode::OK);
    ASSERT_EQ(schema1.Parse().second, proto::StatusCode::OK);
    ASSERT_EQ(schema1.Analyze().second, proto::StatusCode::OK);
    ASSERT_EQ(catalog.LoadScript(schema1, 2), proto::StatusCode::OK);

    flatbuffers::FlatBufferBuilder fb;
    fb.Finish(catalog.Flatten(fb));
    auto flat = flatbuffers::GetRoot<proto::FlatCatalog>(fb.GetBufferPointer());

    // "foo" should get expanded to dashql.default.foo
    // "bar" should get expanded to dashql.default.foo
    // both should be added to the same database

    ASSERT_EQ(flat->databases()->size(), 1);
    ASSERT_EQ(flat->schemas()->size(), 1);
    ASSERT_EQ(flat->tables()->size(), 2);
    ASSERT_EQ(flat->columns()->size(), 2);

    EXPECT_EQ(flat->databases()->Get(0)->catalog_object_id(), INITIAL_DATABASE_ID);
    EXPECT_EQ(flat->schemas()->Get(0)->catalog_object_id(), INITIAL_SCHEMA_ID);

    // Tables names are ordered lexicographically in the flattend schema
    EXPECT_EQ(flat->tables()->Get(0)->catalog_object_id(), ContextObjectID(100, 0).Pack());
    EXPECT_EQ(flat->tables()->Get(1)->catalog_object_id(), ContextObjectID(42, 0).Pack());
    EXPECT_EQ(flat->tables()->Get(0)->flat_parent_idx(), 0);
    EXPECT_EQ(flat->tables()->Get(1)->flat_parent_idx(), 0);
    EXPECT_EQ(flat->tables()->Get(0)->flat_entry_idx(), 0);
    EXPECT_EQ(flat->tables()->Get(1)->flat_entry_idx(), 1);
}

TEST(UnificationTest, MultipleTablesInMultipleSchemas) {
    Catalog catalog;

    Script schema0{catalog, 42};
    Script schema1{catalog, 100};
    schema0.InsertTextAt(0, "create table in_default_0(a int);");
    schema1.InsertTextAt(0, "create table in_default_1(a int); create table separate.schema.in_separate_0(b int);");

    ASSERT_EQ(schema0.Scan().second, proto::StatusCode::OK);
    ASSERT_EQ(schema0.Parse().second, proto::StatusCode::OK);
    ASSERT_EQ(schema0.Analyze().second, proto::StatusCode::OK);
    ASSERT_EQ(catalog.LoadScript(schema0, 1), proto::StatusCode::OK);

    ASSERT_EQ(schema1.Scan().second, proto::StatusCode::OK);
    ASSERT_EQ(schema1.Parse().second, proto::StatusCode::OK);
    ASSERT_EQ(schema1.Analyze().second, proto::StatusCode::OK);
    ASSERT_EQ(catalog.LoadScript(schema1, 2), proto::StatusCode::OK);

    flatbuffers::FlatBufferBuilder fb;
    fb.Finish(catalog.Flatten(fb));
    auto flat = flatbuffers::GetRoot<proto::FlatCatalog>(fb.GetBufferPointer());

    // "in_default_0" should get expanded to dashql.default.in_default_0
    // "in_default_1" should get expanded to dashql.default.in_default_1
    // "separate.schema.in_separate_0" should reside in a separate schema

    ASSERT_EQ(flat->databases()->size(), 2);
    ASSERT_EQ(flat->schemas()->size(), 2);
    ASSERT_EQ(flat->tables()->size(), 3);
    ASSERT_EQ(flat->columns()->size(), 3);

    EXPECT_EQ(flat->databases()->Get(0)->catalog_object_id(), INITIAL_DATABASE_ID + 1);  // "separate"
    EXPECT_EQ(flat->databases()->Get(1)->catalog_object_id(), INITIAL_DATABASE_ID);      // "dashql"
    EXPECT_EQ(flat->schemas()->Get(0)->catalog_object_id(), INITIAL_SCHEMA_ID + 1);      // "schema"
    EXPECT_EQ(flat->schemas()->Get(1)->catalog_object_id(), INITIAL_SCHEMA_ID);          // "default"

    // separate.schema.in_separate_0 is written first
    EXPECT_EQ(flat->tables()->Get(0)->catalog_object_id(), ContextObjectID(100, 1).Pack());
    EXPECT_EQ(flat->tables()->Get(0)->flat_parent_idx(), 0);
    // dashql.default.in_default_0 < dashql.default.in_default_1
    EXPECT_EQ(flat->tables()->Get(1)->catalog_object_id(), ContextObjectID(42, 0).Pack());
    EXPECT_EQ(flat->tables()->Get(2)->catalog_object_id(), ContextObjectID(100, 0).Pack());
    EXPECT_EQ(flat->tables()->Get(1)->flat_parent_idx(), 1);
    EXPECT_EQ(flat->tables()->Get(2)->flat_parent_idx(), 1);
}

TEST(UnificationTest, SimpleTableReference) {
    Catalog catalog;

    Script schema{catalog, 42};
    Script query{catalog, 100};
    schema.InsertTextAt(0, "create table db1.schema1.table1(a int);create table db2.schema2.table2(a int);");
    query.InsertTextAt(0, "select * from db2.schema2.table2");

    ASSERT_EQ(schema.Scan().second, proto::StatusCode::OK);
    ASSERT_EQ(schema.Parse().second, proto::StatusCode::OK);
    ASSERT_EQ(schema.Analyze().second, proto::StatusCode::OK);
    ASSERT_EQ(catalog.LoadScript(schema, 1), proto::StatusCode::OK);

    // Analyze query after loading the schema script in the catalog
    ASSERT_EQ(query.Scan().second, proto::StatusCode::OK);
    ASSERT_EQ(query.Parse().second, proto::StatusCode::OK);
    auto [analyzed, analysis_status] = query.Analyze();
    ASSERT_EQ(analysis_status, proto::StatusCode::OK);

    // Check flattened catalog
    flatbuffers::FlatBufferBuilder fb;
    fb.Finish(catalog.Flatten(fb));
    auto flat = flatbuffers::GetRoot<proto::FlatCatalog>(fb.GetBufferPointer());

    ASSERT_EQ(flat->databases()->size(), 2);
    ASSERT_EQ(flat->schemas()->size(), 2);
    ASSERT_EQ(flat->tables()->size(), 2);
    ASSERT_EQ(flat->columns()->size(), 2);

    ASSERT_EQ(flat->name_dictionary()->Get(flat->databases()->Get(0)->name_id())->string_view(), "db1");
    ASSERT_EQ(flat->name_dictionary()->Get(flat->databases()->Get(1)->name_id())->string_view(), "db2");
    ASSERT_EQ(flat->name_dictionary()->Get(flat->schemas()->Get(0)->name_id())->string_view(), "schema1");
    ASSERT_EQ(flat->name_dictionary()->Get(flat->schemas()->Get(1)->name_id())->string_view(), "schema2");

    EXPECT_EQ(flat->tables()->Get(0)->catalog_object_id(), ContextObjectID(42, 0).Pack());
    EXPECT_EQ(flat->tables()->Get(1)->catalog_object_id(), ContextObjectID(42, 1).Pack());

    // Check table reference
    ASSERT_EQ(analyzed->table_references.GetSize(), 1);
    ASSERT_TRUE(std::holds_alternative<AnalyzedScript::TableReference::ResolvedRelationExpression>(
        analyzed->table_references[0].inner));
    auto& resolved =
        std::get<AnalyzedScript::TableReference::ResolvedRelationExpression>(analyzed->table_references[0].inner);
    ASSERT_EQ(resolved.catalog_database_id, flat->databases()->Get(1)->catalog_object_id());
    ASSERT_EQ(resolved.catalog_schema_id, flat->schemas()->Get(1)->catalog_object_id());
    ASSERT_EQ(resolved.catalog_table_id.Pack(), flat->tables()->Get(1)->catalog_object_id());
}

TEST(UnificationTest, ParallelDatabaseRegistration) {
    Catalog catalog;

    Script schema0{catalog, 42};
    Script schema1{catalog, 100};
    schema0.InsertTextAt(0, "create table db1.schema1.table1(a int);");
    schema1.InsertTextAt(0, "create table db1.schema2.table2(a int);");

    ASSERT_EQ(schema0.Scan().second, proto::StatusCode::OK);
    ASSERT_EQ(schema0.Parse().second, proto::StatusCode::OK);
    ASSERT_EQ(schema0.Analyze().second, proto::StatusCode::OK);

    ASSERT_EQ(schema1.Scan().second, proto::StatusCode::OK);
    ASSERT_EQ(schema1.Parse().second, proto::StatusCode::OK);
    ASSERT_EQ(schema1.Analyze().second, proto::StatusCode::OK);

    ASSERT_EQ(catalog.LoadScript(schema0, 1), proto::StatusCode::OK);
    ASSERT_EQ(catalog.LoadScript(schema1, 2), proto::StatusCode::CATALOG_ID_OUT_OF_SYNC);
}

TEST(UnificationTest, ParallelSchemaRegistration) {
    Catalog catalog;

    Script schema0{catalog, 42};
    Script schema1{catalog, 100};
    schema0.InsertTextAt(0, "create table schema1.table1(a int);");
    schema1.InsertTextAt(0, "create table schema1.table2(a int);");

    ASSERT_EQ(schema0.Scan().second, proto::StatusCode::OK);
    ASSERT_EQ(schema0.Parse().second, proto::StatusCode::OK);
    ASSERT_EQ(schema0.Analyze().second, proto::StatusCode::OK);

    ASSERT_EQ(schema1.Scan().second, proto::StatusCode::OK);
    ASSERT_EQ(schema1.Parse().second, proto::StatusCode::OK);
    ASSERT_EQ(schema1.Analyze().second, proto::StatusCode::OK);

    ASSERT_EQ(catalog.LoadScript(schema0, 1), proto::StatusCode::OK);
    ASSERT_EQ(catalog.LoadScript(schema1, 2), proto::StatusCode::CATALOG_ID_OUT_OF_SYNC);
}

}  // namespace
