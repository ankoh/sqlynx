#include "sqlynx/catalog.h"

#include <flatbuffers/buffer.h>
#include <flatbuffers/flatbuffer_builder.h>

#include "gtest/gtest.h"
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

    auto description = catalog.DescribeEntries();
    ASSERT_EQ(description.entries.size(), 1);
    ASSERT_EQ(description.entries[0].external_id(), 1);
    ASSERT_EQ(description.entries[0].entry_type(), proto::CatalogEntryType::DESCRIPTOR_POOL);

    Script script{catalog, 2};
    {
        script.ReplaceText("select * from db1.schema1.table1");
        ASSERT_EQ(script.Scan().second, proto::StatusCode::OK);
        ASSERT_EQ(script.Parse().second, proto::StatusCode::OK);
        auto [analyzed, analysis_status] = script.Analyze();
        ASSERT_EQ(analysis_status, proto::StatusCode::OK);
        ASSERT_EQ(analyzed->table_references.size(), 1);
        ASSERT_FALSE(analyzed->table_references[0].resolved_table_id.IsNull());
        ASSERT_EQ(analyzed->table_references[0].resolved_table_id.GetExternalId(), 1);
        ASSERT_EQ(analyzed->table_references[0].resolved_table_id.GetIndex(), 0);
    }
    {
        script.ReplaceText("select * from db1.schema1.table2");
        ASSERT_EQ(script.Scan().second, proto::StatusCode::OK);
        ASSERT_EQ(script.Parse().second, proto::StatusCode::OK);
        auto [analyzed, analysis_status] = script.Analyze();
        ASSERT_EQ(analysis_status, proto::StatusCode::OK);
        ASSERT_EQ(analyzed->table_references.size(), 1);
        ASSERT_TRUE(analyzed->table_references[0].resolved_table_id.IsNull());
    }
}

TEST(CatalogTest, DescriptorPoolIDCollision) {
    Catalog catalog;
    ASSERT_EQ(catalog.AddDescriptorPool(1, 10), proto::StatusCode::OK);
    ASSERT_EQ(catalog.AddDescriptorPool(1, 10), proto::StatusCode::EXTERNAL_ID_COLLISION);
}

}  // namespace
