#pragma once

#include <span>

#include "sqlynx/proto/proto_generated.h"

namespace sqlynx {

/// The attribute index provides efficient access to child nodes using the attribute key.
/// It maintains a map of N pointers where N is the total amount of attribute keys in the protocol.
/// Indexing a node means iterating over the children and storing the child nodes into the slot indexed by the
/// key. We use a scope guard to clean up any set pointers when the access is done.
///
/// The attribute index has a high up-front cost as we have to allocate and clear a vector of ~200 node pointers.
/// All of our analysis passes are node-local and won't require us to index multiple nodes simultaneously.
/// We can therefore allocate this index once and reuse it during the tree traversal.
///
/// Without this index, we'd have to implement one of these options instead:
///     A) Load children into a hash map. (overhead)
///     B) Store attributes sorted and merge-join any expected key sequences. (complex logic per node type)
///     C) Emit dynamically-sized structs in the parser. (no longer simple & flat ast)
struct AttributeIndex {
   public:
    /// A scope guard that clears any set pointers on destruction
    struct AccessGuard {
        friend struct AttributeIndex;

       protected:
        /// The state buffer
        std::span<const proto::Node*> attribute_index;
        /// The indexed nodes
        std::span<const proto::Node> indexed_nodes;

        /// Constructor
        AccessGuard(std::span<const proto::Node*> attr_idx, std::span<const proto::Node> idx_nodes)
            : attribute_index(attr_idx), indexed_nodes(idx_nodes) {}
        /// Clear the nodes
        inline void clear() {
            for (auto& node : indexed_nodes) {
                attribute_index[static_cast<size_t>(node.attribute_key())] = nullptr;
            }
            indexed_nodes = {};
        }

       public:
        /// Destructor
        ~AccessGuard() { clear(); };
        /// Move construction
        AccessGuard(AccessGuard&& other) = default;
        /// Move assignment
        AccessGuard& operator=(AccessGuard&& other) = default;
        /// Access the index
        const proto::Node* operator[](proto::AttributeKey key) const {
            return attribute_index[static_cast<size_t>(key)];
        }
    };

   protected:
    /// The children pointers indexed by the attribute key
    std::vector<const proto::Node*> attribute_index;

   public:
    /// Constructor
    AttributeIndex() { attribute_index.resize(static_cast<size_t>(proto::AttributeKey::MAX) + 1, nullptr); }
    /// Load into an attribute map
    inline AccessGuard Load(std::span<const proto::Node> children) {
        for (auto& node : children) {
            auto& slot = attribute_index[static_cast<size_t>(node.attribute_key())];
            assert(slot == nullptr);
            slot = &node;
        }
        return {attribute_index, children};
    }
};

}  // namespace sqlynx
