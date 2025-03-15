#include "benchmark/benchmark.h"
#include "dashql/catalog.h"
#include "dashql/proto/proto_generated.h"

using namespace dashql;

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

std::tuple<std::span<const std::byte>, std::unique_ptr<const std::byte[]>, size_t> pack_schema(const Schema& schema) {
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
    return {data_span, std::move(buffer_owned), buffer_size};
}

std::vector<Schema> generate_test_data(size_t schemas, size_t table_per_schema, size_t columns_per_table) {
    std::vector<Schema> out;
    for (size_t i = 0; i < schemas; ++i) {
        auto& schema = out.emplace_back();
        schema.database_name = "db";
        schema.schema_name = std::format("schema_{}", i);
        for (size_t j = 0; j < table_per_schema; ++j) {
            auto& table = schema.tables.emplace_back();
            table.table_name = std::format("table_{}_{}", i, j);
            for (size_t k = 0; k < columns_per_table; ++k) {
                auto& column = table.table_columns.emplace_back();
                column.column_name = std::format("column_{}_{}_{}", i, j, k);
            }
        }
    }
    return out;
}

static void catalog_update(benchmark::State& state) {
    Catalog catalog;

    std::vector<Schema> schemas = generate_test_data(state.range(0), state.range(1), state.range(2));
    catalog.AddDescriptorPool(1, 1);

    for (auto _ : state) {
        state.PauseTiming();
        for (size_t i = 0; (i + 1) < schemas.size(); ++i) {
            auto& schema = schemas[i];
            auto [descriptor, descriptor_buffer, descriptor_buffer_size] = pack_schema(schema);
            catalog.AddSchemaDescriptor(1, descriptor, std::move(descriptor_buffer), descriptor_buffer_size);
        }
        auto& last = schemas.back();
        auto [descriptor, descriptor_buffer, descriptor_buffer_size] = pack_schema(last);
        state.ResumeTiming();
        catalog.AddSchemaDescriptor(1, descriptor, std::move(descriptor_buffer), descriptor_buffer_size);
    }
}

BENCHMARK(catalog_update)->Args({1, 10, 10})->Args({50, 10, 10})->Args({100, 10, 10});

BENCHMARK_MAIN();
