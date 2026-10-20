#include "dashql/catalog_descriptor.h"

#include <flatbuffers/verifier.h>

#include <set>
#include <stdexcept>

#include "utf8proc/utf8proc_wrapper.hpp"

using namespace dashql;

namespace {

std::string_view Text(const flatbuffers::String* text) {
    return text ? text->string_view() : std::string_view{};
}

void ValidateText(const flatbuffers::String* text, bool required) {
    auto value = Text(text);
    if ((required && value.empty()) || value.find('\0') != std::string_view::npos ||
        !utf8::Utf8Proc::IsValid(value)) {
        throw std::invalid_argument("invalid catalog descriptor name or type");
    }
}

void ValidateDescriptor(std::span<const uint8_t> data) {
    flatbuffers::Verifier verifier{data.data(), data.size()};
    if (data.empty() || !verifier.VerifyBuffer<buffers::catalog::CatalogDescriptor>(nullptr)) {
        throw std::invalid_argument("invalid CatalogDescriptor FlatBuffer");
    }
    auto& descriptor = *flatbuffers::GetRoot<buffers::catalog::CatalogDescriptor>(data.data());
    std::set<CatalogEntry::QualifiedTableName::Key> table_names;
    if (auto* tables = descriptor.tables()) {
        for (auto* table : *tables) {
            if (!table) throw std::invalid_argument("null descriptor table");
            auto* name = table->table_name();
            if (!name) throw std::invalid_argument("missing descriptor table name");
            ValidateText(name->database_name(), false);
            ValidateText(name->schema_name(), false);
            ValidateText(name->table_name(), true);
            if (!table_names.emplace(Text(name->database_name()), Text(name->schema_name()),
                                     Text(name->table_name())).second) {
                throw std::invalid_argument("duplicate descriptor table name");
            }
            std::set<std::string_view> columns;
            if (auto* values = table->table_columns()) {
                for (auto* column : *values) {
                    if (!column) throw std::invalid_argument("null descriptor column");
                    ValidateText(column->column_name(), true);
                    if (!columns.insert(Text(column->column_name())).second) {
                        throw std::invalid_argument("duplicate descriptor column name");
                    }
                }
            }
        }
    }
    if (auto* functions = descriptor.function_declarations()) {
        for (auto* function : *functions) {
            if (!function) throw std::invalid_argument("null descriptor function");
            auto* name = function->function_name();
            if (!name) throw std::invalid_argument("missing descriptor function name");
            ValidateText(name->database_name(), false);
            ValidateText(name->schema_name(), false);
            ValidateText(name->function_name(), true);
            ValidateText(function->return_type(), true);
            // Like script declarations, preserve every overload as a distinct
            // object. The qualified-name index selects the first declaration.
            std::set<std::string_view> params;
            if (auto* values = function->params()) {
                for (auto* param : *values) {
                    if (!param) throw std::invalid_argument("null descriptor parameter");
                    ValidateText(param->param_name(), false);
                    ValidateText(param->param_type(), true);
                    auto name = Text(param->param_name());
                    if (!name.empty() && !params.insert(name).second) {
                        throw std::invalid_argument("duplicate descriptor parameter name");
                    }
                }
            }
        }
    }
    // Producer IDs and AST offsets are intentionally ignored. All receiver
    // ordinals come from verified FlatBuffer vectors (bounded by uint32_t).
}

}  // namespace

DescriptorPool::DescriptorPool(std::span<const uint8_t> bytes)
    : data(bytes.empty() ? std::vector<uint8_t>{} : std::vector<uint8_t>{bytes.begin(), bytes.end()}) {
    ValidateDescriptor(data);
}

const buffers::catalog::CatalogDescriptor& DescriptorPool::GetDescriptor() const {
    return *flatbuffers::GetRoot<buffers::catalog::CatalogDescriptor>(data.data());
}

DescriptorEntry::DescriptorEntry(Catalog& catalog, CatalogEntryID id, Rank rank,
                                 std::shared_ptr<const DescriptorPool> pool)
    : CatalogEntry(catalog, id), pool(std::move(pool)), rank(rank) {
    auto register_schema = [&](RegisteredName& database, RegisteredName& schema) {
        QualifiedCatalogObjectID db_id;
        if (auto iter = databases_by_name.find(database.text); iter != databases_by_name.end()) {
            db_id = iter->second.get().object_id;
        } else {
            db_id = catalog.ReserveDatabaseId(database.text);
            auto& ref = database_references.PushBack(DatabaseReference{db_id, database.text, ""});
            databases_by_name.emplace(database.text, ref);
            database.resolved_objects.PushBack(ref);
        }
        auto key = std::pair{database.text, schema.text};
        if (auto iter = schemas_by_qualified_name.find(key); iter != schemas_by_qualified_name.end()) {
            return iter->second.get().object_id;
        }
        auto schema_id = catalog.ReserveSchemaId(database.text, schema.text, db_id);
        auto& ref = schema_references.PushBack(SchemaReference{schema_id, database.text, schema.text});
        schemas_by_qualified_name.emplace(key, ref);
        schema.resolved_objects.PushBack(ref);
        return schema_id;
    };
    auto& descriptor = this->pool->GetDescriptor();
    if (auto* tables = descriptor.tables()) {
        for (auto* source : *tables) {
            auto* name = source->table_name();
            auto& db = names.Register(Text(name->database_name()), {}, buffers::analyzer::NameTag::DATABASE_NAME);
            auto& schema = names.Register(Text(name->schema_name()), {}, buffers::analyzer::NameTag::SCHEMA_NAME);
            auto& table_name = names.Register(Text(name->table_name()), {}, buffers::analyzer::NameTag::TABLE_NAME);
            auto schema_id = register_schema(db, schema);
            CatalogTableID table_id{id, static_cast<uint32_t>(table_declarations.GetSize())};
            auto& table = table_declarations.PushBack(
                TableDeclaration{schema_id, table_id, QualifiedTableName{std::nullopt, db, schema, table_name}});
            table.catalog_version = catalog_version + 1;
            table_name.resolved_objects.PushBack(table);
            if (auto* columns = source->table_columns()) {
                table.table_columns.reserve(columns->size());
                for (auto* source_column : *columns) {
                    auto& column_name = names.Register(Text(source_column->column_name()), {},
                                                       buffers::analyzer::NameTag::COLUMN_NAME);
                    auto ordinal = static_cast<uint32_t>(table.table_columns.size());
                    table.table_columns.emplace_back(table_id, ordinal, std::nullopt, column_name);
                    auto& column = table.table_columns.back();
                    column.table = table;
                    column_name.resolved_objects.PushBack(column);
                    table.table_columns_by_name.emplace(column_name.text, column);
                    table_columns_by_name.insert({column_name.text, column});
                }
            }
            tables_by_qualified_name.emplace(QualifiedTableName::Key{db.text, schema.text, table_name.text}, table);
            tables_by_unqualified_name.insert({table_name.text, table});
            tables_by_unqualified_schema.insert({{schema.text, db.text}, table});
        }
    }
    if (auto* functions = descriptor.function_declarations()) {
        for (auto* source : *functions) {
            auto* name = source->function_name();
            auto& db = names.Register(Text(name->database_name()), {}, buffers::analyzer::NameTag::DATABASE_NAME);
            auto& schema = names.Register(Text(name->schema_name()), {}, buffers::analyzer::NameTag::SCHEMA_NAME);
            auto& function_name =
                names.Register(Text(name->function_name()), {}, buffers::analyzer::NameTag::FUNCTION_NAME);
            auto schema_id = register_schema(db, schema);
            CatalogFunctionID function_id{id, static_cast<uint32_t>(function_declarations.GetSize())};
            auto& function = function_declarations.PushBack(FunctionDeclaration{
                schema_id, function_id, QualifiedFunctionName{std::nullopt, db, schema, function_name}});
            function.is_aggregate = source->is_aggregate();
            function.return_type = Text(source->return_type());
            if (auto* params = source->params()) {
                for (auto* param : *params) {
                    auto& param_name = names.Register(Text(param->param_name()));
                    function.params.emplace_back(std::nullopt, param_name, Text(param->param_type()));
                }
            }
            function_name.resolved_objects.PushBack(function);
            functions_by_qualified_name.emplace(
                QualifiedFunctionName::Key{db.text, schema.text, function_name.text}, function);
            functions_by_unqualified_name.insert({function_name.text, function});
        }
    }
}

const CatalogEntry::NameSearchIndex& DescriptorEntry::GetNameSearchIndex() {
    if (!name_search_index) {
        auto& index = name_search_index.emplace();
        for (auto& chunk : names.GetChunks()) {
            for (auto& name : chunk) {
                for (size_t i = 0; i < name.text.size(); ++i) {
                    auto suffix = name.text.substr(i);
                    index.insert({{suffix.data(), suffix.size()}, name});
                }
            }
        }
    }
    return *name_search_index;
}

flatbuffers::Offset<buffers::catalog::CatalogEntry> DescriptorEntry::DescribeEntry(
    flatbuffers::FlatBufferBuilder& builder) const {
    std::vector<flatbuffers::Offset<buffers::catalog::SchemaDescriptor>> schema_offsets;
    for (auto& [key, schema] : schemas_by_qualified_name) {
        std::vector<flatbuffers::Offset<buffers::catalog::SchemaTable>> tables;
        for (auto& chunk : table_declarations.GetChunks()) {
            for (auto& table : chunk) {
                if (table.catalog_schema_id != schema.get().object_id) continue;
                std::vector<flatbuffers::Offset<buffers::catalog::SchemaTableColumn>> columns;
                for (auto& column : table.table_columns) {
                    columns.push_back(buffers::catalog::CreateSchemaTableColumn(
                        builder, builder.CreateString(column.column_name.get().text), column.GetColumnIndex()));
                }
                auto columns_offset = builder.CreateVector(columns);
                auto name = builder.CreateString(table.table_name.table_name.get().text);
                tables.push_back(buffers::catalog::CreateSchemaTable(builder, table.GetTableID().GetObject(), name,
                                                                     columns_offset));
            }
        }
        auto tables_offset = builder.CreateVector(tables);
        auto db = builder.CreateString(key.first);
        auto name = builder.CreateString(key.second);
        schema_offsets.push_back(buffers::catalog::CreateSchemaDescriptor(builder, db, name, tables_offset));
    }
    auto schemas_offset = builder.CreateVector(schema_offsets);
    return buffers::catalog::CreateCatalogEntry(
        builder, catalog_entry_id, buffers::catalog::CatalogEntryType::DESCRIPTOR_POOL, rank, schemas_offset);
}

flatbuffers::DetachedBuffer dashql::PackCatalogDescriptor(const CatalogEntry& entry) {
    flatbuffers::FlatBufferBuilder builder;
    std::vector<flatbuffers::Offset<buffers::analyzer::Table>> tables;
    std::vector<flatbuffers::Offset<buffers::analyzer::FunctionDeclaration>> functions;
    for (auto& chunk : entry.GetTables().GetChunks()) {
        for (auto& table : chunk) tables.push_back(table.Pack(builder));
    }
    for (auto& chunk : entry.GetFunctions().GetChunks()) {
        for (auto& function : chunk) functions.push_back(function.Pack(builder));
    }
    auto tables_offset = builder.CreateVector(tables);
    auto functions_offset = builder.CreateVector(functions);
    builder.Finish(buffers::catalog::CreateCatalogDescriptor(builder, tables_offset, functions_offset));
    ValidateDescriptor({builder.GetBufferPointer(), builder.GetSize()});
    return builder.Release();
}
