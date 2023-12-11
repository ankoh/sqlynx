#include "sqlynx/schema.h"

using namespace sqlynx;

Schema::Schema(uint32_t context_id) : context_id(context_id) {}

std::optional<std::pair<std::reference_wrapper<const Schema::Table>, std::span<const Schema::TableColumn>>>
Schema::FindTable(QualifiedID table_id) const {
    if (table_id.GetContext() != context_id || table_id.GetIndex() >= tables.size()) {
        return std::nullopt;
    }
    auto& table = tables[table_id.GetIndex()];
    auto columns = std::span{table_columns}.subspan(table.columns_begin, table.column_count);
    return std::make_pair(table, columns);
}
