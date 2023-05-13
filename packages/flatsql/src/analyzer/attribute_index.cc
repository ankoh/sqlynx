#include "flatsql/analyzer/attribute_index.h"

#include "flatsql/proto/proto_generated.h"

namespace flatsql {

AttributeIndex::AttributeIndex() { attribute_index.resize(static_cast<size_t>(proto::AttributeKey::MAX) + 1, nullptr); }

AttributeIndex::AccessGuard AttributeIndex::Load(std::span<const proto::Node> children) {
    for (auto& node : children) {
        auto& slot = attribute_index[static_cast<size_t>(node.attribute_key())];
        assert(slot == nullptr);
        slot = &node;
    }
    return {attribute_index, children};
}

AttributeIndex::AccessGuard::~AccessGuard() {
    for (auto& node : indexed_nodes) {
        attribute_index[static_cast<size_t>(node.attribute_key())] = nullptr;
    }
    indexed_nodes = {};
}

AttributeIndex::AccessGuard::AccessGuard(AccessGuard&& other)
    : attribute_index(other.attribute_index), indexed_nodes(other.indexed_nodes) {
    other.indexed_nodes = {};
}

AttributeIndex::AccessGuard& AttributeIndex::AccessGuard::operator=(AttributeIndex::AccessGuard&& other) {
    clear();
    attribute_index = other.attribute_index;
    indexed_nodes = other.indexed_nodes;
    other.indexed_nodes = {};
    return *this;
}

}  // namespace flatsql
