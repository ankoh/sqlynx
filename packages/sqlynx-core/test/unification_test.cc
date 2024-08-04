#include "gtest/gtest.h"
#include "sqlynx/catalog.h"
#include "sqlynx/external.h"
#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/script.h"

using namespace sqlynx;

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

    // "foo" should get expanded to sqlynx.default.foo
    // The flat catalog should therefore have exactly 1 database, 1 schema, 1 table, 1 column
    ASSERT_EQ(flat->databases()->size(), 1);
    ASSERT_EQ(flat->schemas()->size(), 1);
    ASSERT_EQ(flat->tables()->size(), 1);
    ASSERT_EQ(flat->columns()->size(), 1);
    ASSERT_EQ(flat->databases()->Get(0)->catalog_object_id(), 0);
    ASSERT_EQ(flat->schemas()->Get(0)->catalog_object_id(), 1);
    ASSERT_EQ(flat->tables()->Get(0)->catalog_object_id(), ExternalObjectID(42, 0).Pack());

    // Check names
    EXPECT_EQ(flat->name_dictionary()->size(), 4);
    EXPECT_EQ(flat->name_dictionary()->Get(flat->databases()->Get(0)->name_id())->string_view(), "sqlynx");
    EXPECT_EQ(flat->name_dictionary()->Get(flat->schemas()->Get(0)->name_id())->string_view(), "default");
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
    ASSERT_EQ(schema1.Scan().second, proto::StatusCode::OK);
    ASSERT_EQ(schema1.Parse().second, proto::StatusCode::OK);
    ASSERT_EQ(schema1.Analyze().second, proto::StatusCode::OK);

    ASSERT_EQ(catalog.LoadScript(schema0, 1), proto::StatusCode::OK);
    ASSERT_EQ(catalog.LoadScript(schema1, 2), proto::StatusCode::OK);

    flatbuffers::FlatBufferBuilder fb;
    fb.Finish(catalog.Flatten(fb));
    auto flat = flatbuffers::GetRoot<proto::FlatCatalog>(fb.GetBufferPointer());

    // "foo" should get expanded to sqlynx.default.foo
    // "bar" should get expanded to sqlynx.default.foo
    // both should be added to the same database

    ASSERT_EQ(flat->databases()->size(), 1);
    ASSERT_EQ(flat->schemas()->size(), 1);
    ASSERT_EQ(flat->tables()->size(), 2);
    ASSERT_EQ(flat->columns()->size(), 2);

    EXPECT_EQ(flat->databases()->Get(0)->catalog_object_id(), 0);
    EXPECT_EQ(flat->schemas()->Get(0)->catalog_object_id(), 1);

    // Tables names are ordered lexicographically in the flattend schema
    EXPECT_EQ(flat->tables()->Get(0)->catalog_object_id(), ExternalObjectID(100, 0).Pack());
    EXPECT_EQ(flat->tables()->Get(1)->catalog_object_id(), ExternalObjectID(42, 0).Pack());
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
    ASSERT_EQ(schema1.Scan().second, proto::StatusCode::OK);
    ASSERT_EQ(schema1.Parse().second, proto::StatusCode::OK);
    ASSERT_EQ(schema1.Analyze().second, proto::StatusCode::OK);

    ASSERT_EQ(catalog.LoadScript(schema0, 1), proto::StatusCode::OK);
    ASSERT_EQ(catalog.LoadScript(schema1, 2), proto::StatusCode::OK);

    flatbuffers::FlatBufferBuilder fb;
    fb.Finish(catalog.Flatten(fb));
    auto flat = flatbuffers::GetRoot<proto::FlatCatalog>(fb.GetBufferPointer());

    // "in_default_0" should get expanded to sqlynx.default.in_default_0
    // "in_default_1" should get expanded to sqlynx.default.in_default_1
    // "separate.schema.in_separate_0" should reside in a separate schema

    ASSERT_EQ(flat->databases()->size(), 2);
    ASSERT_EQ(flat->schemas()->size(), 2);
    ASSERT_EQ(flat->tables()->size(), 3);
    ASSERT_EQ(flat->columns()->size(), 3);

    EXPECT_EQ(flat->databases()->Get(0)->catalog_object_id(), 2);  // "separate"
    EXPECT_EQ(flat->databases()->Get(1)->catalog_object_id(), 0);  // "sqlynx"
    EXPECT_EQ(flat->schemas()->Get(0)->catalog_object_id(), 3);    // "schema"
    EXPECT_EQ(flat->schemas()->Get(1)->catalog_object_id(), 1);    // "default"

    // separate.schema.in_separate_0 is written first
    EXPECT_EQ(flat->tables()->Get(0)->catalog_object_id(), ExternalObjectID(100, 1).Pack());
    EXPECT_EQ(flat->tables()->Get(0)->flat_parent_idx(), 0);
    // sqlynx.default.in_default_0 < sqlynx.default.in_default_1
    EXPECT_EQ(flat->tables()->Get(1)->catalog_object_id(), ExternalObjectID(42, 0).Pack());
    EXPECT_EQ(flat->tables()->Get(2)->catalog_object_id(), ExternalObjectID(100, 0).Pack());
    EXPECT_EQ(flat->tables()->Get(1)->flat_parent_idx(), 1);
    EXPECT_EQ(flat->tables()->Get(2)->flat_parent_idx(), 1);
}

}  // namespace
