#include "sqlynx/catalog.h"

#include <flatbuffers/buffer.h>
#include <flatbuffers/flatbuffer_builder.h>

#include "gtest/gtest.h"
#include "sqlynx/analyzer/analyzer.h"
#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/script.h"

using namespace sqlynx;

namespace {

struct SchemaTableColumn {
    std::string column_name;
};

struct SchemaTable {
    std::string table_name;
    std::vector<SchemaTableColumn> table_columns;
};

struct Schema {
    std::string database_name;
    std::string schema_name;
    std::vector<SchemaTable> tables;
};

std::pair<std::span<const std::byte>, std::unique_ptr<const std::byte[]>> PackSchema(const Schema& schema) {
    flatbuffers::FlatBufferBuilder fbb;
    auto database_name = fbb.CreateString(schema.database_name);
    auto schema_name = fbb.CreateString(schema.schema_name);
    std::vector<flatbuffers::Offset<proto::SchemaTable>> tables;
    std::vector<flatbuffers::Offset<proto::SchemaTableColumn>> table_columns;
    for (auto& table : schema.tables) {
        table_columns.clear();
        for (auto& column : table.table_columns) {
            auto column_name = fbb.CreateString(column.column_name);
            proto::SchemaTableColumnBuilder column_builder{fbb};
            column_builder.add_column_name(column_name);
            table_columns.push_back(column_builder.Finish());
        }
        auto table_columns_ofs = fbb.CreateVector(table_columns);
        auto table_name_ofs = fbb.CreateString(table.table_name);
        proto::SchemaTableBuilder table_builder{fbb};
        table_builder.add_table_name(table_name_ofs);
        table_builder.add_columns(table_columns_ofs);
        tables.push_back(table_builder.Finish());
    }
    auto tables_ofs = fbb.CreateVector(tables);
    proto::SchemaDescriptorBuilder descriptor_builder{fbb};
    descriptor_builder.add_database_name(database_name);
    descriptor_builder.add_schema_name(schema_name);
    descriptor_builder.add_tables(tables_ofs);
    fbb.Finish(descriptor_builder.Finish());
    size_t buffer_size = 0;
    size_t buffer_offset = 0;
    auto buffer = fbb.ReleaseRaw(buffer_size, buffer_offset);
    auto buffer_owned = std::unique_ptr<const std::byte[]>(reinterpret_cast<const std::byte*>(buffer));
    std::span<const std::byte> data_span{buffer_owned.get() + buffer_offset, buffer_size - buffer_offset};
    return {data_span, std::move(buffer_owned)};
}

TEST(CatalogTest, Clear) {
    Catalog catalog;
    ASSERT_EQ(catalog.AddDescriptorPool(1, 10), proto::StatusCode::OK);

    auto [descriptor, descriptor_buffer] = PackSchema(Schema{
        .database_name = "db1",
        .schema_name = "schema1",
        .tables = {SchemaTable{
            .table_name = "table1",
            .table_columns = {SchemaTableColumn{.column_name = "column1"}, SchemaTableColumn{.column_name = "column2"},
                              SchemaTableColumn{.column_name = "column3"}}}},
    });
    auto status = catalog.AddSchemaDescriptor(1, descriptor, std::move(descriptor_buffer));
    ASSERT_EQ(status, proto::StatusCode::OK);

    {
        flatbuffers::FlatBufferBuilder fb;
        fb.Finish(catalog.DescribeEntries(fb));
        auto description = flatbuffers::GetRoot<proto::CatalogEntries>(fb.GetBufferPointer());
        ASSERT_EQ(description->entries()->size(), 1);
        ASSERT_EQ(description->entries()->Get(0)->catalog_entry_id(), 1);
        ASSERT_EQ(description->entries()->Get(0)->catalog_entry_type(), proto::CatalogEntryType::DESCRIPTOR_POOL);
    }
    catalog.Clear();
    {
        flatbuffers::FlatBufferBuilder fb;
        fb.Finish(catalog.DescribeEntries(fb));
        auto description = flatbuffers::GetRoot<proto::CatalogEntries>(fb.GetBufferPointer());
        ASSERT_EQ(description->entries()->size(), 0);
    }
}

TEST(CatalogTest, SingleDescriptorPool) {
    Catalog catalog;
    ASSERT_EQ(catalog.AddDescriptorPool(1, 10), proto::StatusCode::OK);

    auto [descriptor, descriptor_buffer] = PackSchema(Schema{
        .database_name = "db1",
        .schema_name = "schema1",
        .tables = {SchemaTable{
            .table_name = "table1",
            .table_columns = {SchemaTableColumn{.column_name = "column1"}, SchemaTableColumn{.column_name = "column2"},
                              SchemaTableColumn{.column_name = "column3"}}}},
    });
    auto status = catalog.AddSchemaDescriptor(1, descriptor, std::move(descriptor_buffer));
    ASSERT_EQ(status, proto::StatusCode::OK);

    {
        flatbuffers::FlatBufferBuilder fb;
        fb.Finish(catalog.DescribeEntries(fb));
        auto description = flatbuffers::GetRoot<proto::CatalogEntries>(fb.GetBufferPointer());
        ASSERT_EQ(description->entries()->size(), 1);
        ASSERT_EQ(description->entries()->Get(0)->catalog_entry_id(), 1);
        ASSERT_EQ(description->entries()->Get(0)->catalog_entry_type(), proto::CatalogEntryType::DESCRIPTOR_POOL);
    }

    Script script{catalog, 2};
    {
        script.ReplaceText("select * from db1.schema1.table1");
        ASSERT_EQ(script.Scan().second, proto::StatusCode::OK);
        ASSERT_EQ(script.Parse().second, proto::StatusCode::OK);
        auto [analyzed, analysis_status] = script.Analyze();
        ASSERT_EQ(analysis_status, proto::StatusCode::OK);
        ASSERT_EQ(analyzed->table_references.size(), 1);
        ASSERT_FALSE(analyzed->table_references[0].resolved_catalog_table_id.IsNull());
        ASSERT_EQ(analyzed->table_references[0].resolved_catalog_table_id.GetExternalId(), 1);
        ASSERT_EQ(analyzed->table_references[0].resolved_catalog_table_id.GetIndex(), 0);
    }
    {
        script.ReplaceText("select * from db1.schema1.table2");
        ASSERT_EQ(script.Scan().second, proto::StatusCode::OK);
        ASSERT_EQ(script.Parse().second, proto::StatusCode::OK);
        auto [analyzed, analysis_status] = script.Analyze();
        ASSERT_EQ(analysis_status, proto::StatusCode::OK);
        ASSERT_EQ(analyzed->table_references.size(), 1);
        ASSERT_TRUE(analyzed->table_references[0].resolved_catalog_table_id.IsNull());
    }
}

TEST(CatalogTest, DescriptorPoolIDCollision) {
    Catalog catalog;
    ASSERT_EQ(catalog.AddDescriptorPool(1, 10), proto::StatusCode::OK);
    ASSERT_EQ(catalog.AddDescriptorPool(1, 10), proto::StatusCode::EXTERNAL_ID_COLLISION);
}

TEST(CatalogTest, FlattenEmpty) {
    Catalog catalog;
    flatbuffers::FlatBufferBuilder fb;
    fb.Finish(catalog.Flatten(fb));
    auto flat = flatbuffers::GetRoot<proto::FlatCatalog>(fb.GetBufferPointer());
    ASSERT_EQ(flat->catalog_version(), catalog.GetVersion());
}

TEST(CatalogTest, FlattenSingleDescriptorPool) {
    Catalog catalog;
    ASSERT_EQ(catalog.AddDescriptorPool(1, 10), proto::StatusCode::OK);

    auto [descriptor, descriptor_buffer] = PackSchema(Schema{
        .database_name = "db1",
        .schema_name = "schema1",
        .tables = {SchemaTable{.table_name = "table1",
                               .table_columns = {SchemaTableColumn{.column_name = "column1"},
                                                 SchemaTableColumn{.column_name = "column2"},
                                                 SchemaTableColumn{.column_name = "column3"}}

                   },
                   SchemaTable{.table_name = "table2",
                               .table_columns = {SchemaTableColumn{.column_name = "column1"},
                                                 SchemaTableColumn{.column_name = "column2"},
                                                 SchemaTableColumn{.column_name = "column4"}}

                   }},
    });
    auto status = catalog.AddSchemaDescriptor(1, descriptor, std::move(descriptor_buffer));
    ASSERT_EQ(status, proto::StatusCode::OK);

    flatbuffers::FlatBufferBuilder fb;
    fb.Finish(catalog.Flatten(fb));
    auto flat = flatbuffers::GetRoot<proto::FlatCatalog>(fb.GetBufferPointer());
    ASSERT_EQ(flat->catalog_version(), catalog.GetVersion());
    ASSERT_EQ(flat->databases()->size(), 1);
    ASSERT_EQ(flat->schemas()->size(), 1);
    ASSERT_EQ(flat->tables()->size(), 2);
    ASSERT_EQ(flat->columns()->size(), 6);
    ASSERT_EQ(flat->name_dictionary()->size(), 8);
}

constexpr std::string_view TPCH_SCHEMA = R"SQL(
create table part (
   p_partkey integer not null,
   p_name varchar(55) not null,
   p_mfgr char(25) not null,
   p_brand char(10) not null,
   p_type varchar(25) not null,
   p_size integer not null,
   p_container char(10) not null,
   p_retailprice decimal(12,2) not null,
   p_comment varchar(23) not null,
   primary key (p_partkey)
);

create table supplier (
   s_suppkey integer not null,
   s_name char(25) not null,
   s_address varchar(40) not null,
   s_nationkey integer not null,
   s_phone char(15) not null,
   s_acctbal decimal(12,2) not null,
   s_comment varchar(101) not null,
   primary key (s_suppkey)
);

create table partsupp (
   ps_partkey integer not null,
   ps_suppkey integer not null,
   ps_availqty integer not null,
   ps_supplycost decimal(12,2) not null,
   ps_comment varchar(199) not null,
   primary key (ps_partkey,ps_suppkey)
);

create table customer (
   c_custkey integer not null,
   c_name varchar(25) not null,
   c_address varchar(40) not null,
   c_nationkey integer not null,
   c_phone char(15) not null,
   c_acctbal decimal(12,2) not null,
   c_mktsegment char(10) not null,
   c_comment varchar(117) not null,
   primary key (c_custkey)
);

create table orders (
   o_orderkey integer not null,
   o_custkey integer not null,
   o_orderstatus char(1) not null,
   o_totalprice decimal(12,2) not null,
   o_orderdate date not null,
   o_orderpriority char(15) not null,
   o_clerk char(15) not null,
   o_shippriority integer not null,
   o_comment varchar(79) not null,
   primary key (o_orderkey)
);

create table lineitem (
   l_orderkey integer not null,
   l_partkey integer not null,
   l_suppkey integer not null,
   l_linenumber integer not null,
   l_quantity decimal(12,2) not null,
   l_extendedprice decimal(12,2) not null,
   l_discount decimal(12,2) not null,
   l_tax decimal(12,2) not null,
   l_returnflag char(1) not null,
   l_linestatus char(1) not null,
   l_shipdate date not null,
   l_commitdate date not null,
   l_receiptdate date not null,
   l_shipinstruct char(25) not null,
   l_shipmode char(10) not null,
   l_comment varchar(44) not null,
   primary key (l_orderkey,l_linenumber)
);

create table nation (
   n_nationkey integer not null,
   n_name char(25) not null,
   n_regionkey integer not null,
   n_comment varchar(152) not null,
   primary key (n_nationkey)
);

create table region (
   r_regionkey integer not null,
   r_name char(25) not null,
   r_comment varchar(152) not null,
   primary key (r_regionkey)
);
)SQL";

TEST(CatalogTest, FlattenExampleSchema) {
    Catalog catalog;

    // Create script with TPCH schema
    Script script{catalog, 1};
    script.InsertTextAt(0, TPCH_SCHEMA);
    auto [scanned, scanner_status] = script.Scan();
    ASSERT_EQ(scanner_status, proto::StatusCode::OK);
    auto [parsed, parser_status] = script.Parse();
    ASSERT_EQ(parser_status, proto::StatusCode::OK);
    auto [analyzed, analyzer_status] = script.Analyze();
    ASSERT_EQ(analyzer_status, proto::StatusCode::OK);

    // Make sure the analyzed script matches expectations
    ASSERT_EQ(analyzed->GetDatabasesByName().size(), 1);
    ASSERT_EQ(analyzed->GetSchemasByName().size(), 1);
    ASSERT_EQ(analyzed->GetTablesByName().size(), 8);

    // Add to catalog
    auto catalog_status = catalog.LoadScript(script, 1);
    ASSERT_EQ(catalog_status, proto::StatusCode::OK);

    // Flatten the catalog
    flatbuffers::FlatBufferBuilder fb;
    fb.Finish(catalog.Flatten(fb));
    auto flat = flatbuffers::GetRoot<proto::FlatCatalog>(fb.GetBufferPointer());

    // Test the catalog
    ASSERT_EQ(flat->catalog_version(), catalog.GetVersion());
    ASSERT_EQ(flat->databases()->size(), 1);
    ASSERT_EQ(flat->schemas()->size(), 1);
}

}  // namespace
