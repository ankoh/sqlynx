#include "flatsql/parser/grammar/nodes.h"

#include <sstream>
#include <unordered_map>

#include "flatsql/proto/proto_generated.h"

namespace flatsql {
namespace parser {

/// Create a qualified name
proto::Node QualifiedName(ParserDriver& driver, proto::Location loc, std::vector<proto::Node>&& nodes) {
    ssize_t name_length = 0;
    ssize_t first_indirection = -1;
    for (ssize_t i = 0; i < nodes.size(); ++i) {
        if (nodes[i].node_type() == proto::NodeType::OBJECT_SQL_INDIRECTION_INDEX) {
            first_indirection = i;
            break;
        } else if (nodes[i].node_type() == proto::NodeType::IDENTIFIER ||
                   nodes[i].node_type() == proto::NodeType::LITERAL_STRING) {
            ++name_length;
            continue;
        }
        break;
    }
    // clang-format off
    auto maybe_indirection = (first_indirection == -1)
        ? Null()
        : (Attr(Key::SQL_QUALIFIED_NAME_INDEX, std::move(nodes[first_indirection])));
    switch (name_length) {
        case 0: return Null();
        case 1: return driver.Add(loc, proto::NodeType::OBJECT_SQL_QUALIFIED_NAME, {
            maybe_indirection,
            Attr(Key::SQL_QUALIFIED_NAME_RELATION, std::move(nodes[0])),
        });
        case 2: return driver.Add(loc, proto::NodeType::OBJECT_SQL_QUALIFIED_NAME, {
            maybe_indirection,
            Attr(Key::SQL_QUALIFIED_NAME_SCHEMA, std::move(nodes[0])),
            Attr(Key::SQL_QUALIFIED_NAME_RELATION, std::move(nodes[1])),
        });
        default: return driver.Add(loc, proto::NodeType::OBJECT_SQL_QUALIFIED_NAME, {
            maybe_indirection,
            Attr(Key::SQL_QUALIFIED_NAME_CATALOG, std::move(nodes[0])),
            Attr(Key::SQL_QUALIFIED_NAME_RELATION, std::move(nodes[3])),
            Attr(Key::SQL_QUALIFIED_NAME_SCHEMA, std::move(nodes[2])),
        });
    }
    // clang-format on
}

}  // namespace parser
}  // namespace flatsql
