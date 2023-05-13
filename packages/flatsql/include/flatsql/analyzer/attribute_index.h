#pragma once

#include <span>

#include "flatsql/proto/proto_generated.h"

namespace flatsql {

/// The attribute index allows us to efficiently access child nodes using the attribute key.
/// It maintains a map of N pointers where N is the total amount of attribute keys in the protocol.
/// Indexing a node means iterating over the children and storing the child nodes into the slot indexed by the
/// key. We use a scope guard to clean up any set pointers when the access is done.
///
/// The attribute index has a high up-front cost as we have to allocate and clear a vector of ~200 node pointers.
/// All of our analysis passes are node-local and won't require us to index multiple nodes simultaneously.
/// We can therefore allocate this index once and reuse it during the tree traversal.
struct AttributeIndex {
   public:
    /// A scope guard that clears any set state pointers on destruction
    struct AccessGuard {
        friend struct AttributeIndex;

       protected:
        /// The state buffer
        std::span<const proto::Node*> attribute_index;
        /// The indexed nodes
        std::span<const proto::Node> indexed_nodes;

        /// Constructor
        AccessGuard(std::span<const proto::Node*> attribute_index, std::span<const proto::Node> indexed_nodes);
        /// Clear the nodes
        void clear();

       public:
        /// Destructor
        ~AccessGuard();
        /// Move construction
        AccessGuard(AccessGuard&& other);
        /// Move assignment
        AccessGuard& operator=(AccessGuard&& other);
        /// Access the index
        const proto::Node* operator[](proto::AttributeKey key) { return attribute_index[static_cast<size_t>(key)]; }
    };

   protected:
    /// The state pointers
    std::vector<const proto::Node*> attribute_index;

   public:
    /// Constructor
    AttributeIndex();
    /// Load into an attribute map
    AccessGuard Load(std::span<const proto::Node> children);
};

}  // namespace flatsql
