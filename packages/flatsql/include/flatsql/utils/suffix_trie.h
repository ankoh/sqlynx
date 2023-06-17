#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string_view>

#include "flatsql/proto/proto_generated.h"
#include "flatsql/text/rope.h"
#include "flatsql/utils/chunk_buffer.h"

namespace flatsql {

/// A suffix trie indexing immutable suffixes as bulk-loaded adaptive radix tree.
struct SuffixTrie {
   public:
    using ValueType = void *;
    using ContextType = void *;

    struct Node;
    struct LeafNode;

    /// An entry in the trie
    struct Entry {
        /// The key
        std::string_view suffix;
        /// The value
        ValueType value;
    };
    using IterationCallback = void (*)(ContextType context, std::span<Entry>);

    /// A node type
    enum class NodeType : uint8_t {
        None,
        LeafNode,
        InnerNode4,
        InnerNode16,
        InnerNode48,
        InnerNode256,
    };
    /// This struct is included as part of all the various node sizes
    struct Node {
        /// The node type
        NodeType node_type;
        /// The key (partial for inner nodes, full for leafs)
        std::string_view key;

        /// Constructor
        Node(NodeType type, std::string_view key) : node_type(type), key(key) {}
        /// Checks if a leaf matches a prefix
        size_t Match(std::string_view prefix);
    };
    /// Represents a leaf. These are of arbitrary size, as they include the key.
    struct LeafNode : public Node {
        /// The value
        std::span<Entry> entries;

        /// Constructor
        LeafNode(std::string_view key, std::span<Entry> entries) : Node(NodeType::LeafNode, key), entries(entries) {}
    };
    /// Small node with only 4 children
    struct InnerNode4 : public Node {
        /// The keys
        std::array<unsigned char, 4> child_keys;
        /// The children
        std::array<Node *, 4> children;

        /// Constructor
        InnerNode4(std::string_view partial);
        /// Find a child
        Node *Find(unsigned char c);
    };
    /// Small node with 16 children
    struct InnerNode16 : public Node {
        /// The keys
        std::array<unsigned char, 16> child_keys;
        /// The children
        std::array<Node *, 16> children;

        /// Constructor
        InnerNode16(std::string_view partial);
        /// Find a child
        Node *Find(unsigned char c);
    };
    /// Node with 48 children, but a full 256 byte field.
    struct InnerNode48 : public Node {
        /// The keys
        std::array<unsigned char, 256> child_ids;
        /// The children
        std::array<Node *, 48> children;
        /// The number of children
        uint8_t num_children = 0;

        /// Constructor
        InnerNode48(std::string_view partial);
        /// Find a child
        inline Node *Find(unsigned char c) { return c == 0 ? nullptr : children[child_ids[c]]; }
    };
    /// Full node with 256 children
    struct InnerNode256 : public Node {
        /// The children
        std::array<Node *, 256> children;

        /// Constructor
        InnerNode256(std::string_view partial);
        /// Find a child
        inline Node *Find(unsigned char c) { return children[c]; }
    };

   protected:
    /// The root of the tree
    Node *root;
    /// The trie entries
    std::vector<Entry> entries;
    /// The leaf nodes
    ChunkBuffer<LeafNode, 16> leaf_nodes;
    /// The inner nodes with capacity 4
    ChunkBuffer<InnerNode4, 16> inner_nodes_4;
    /// The inner nodes with capacity 16
    ChunkBuffer<InnerNode16, 16> inner_nodes_16;
    /// The inner nodes with capacity 48
    ChunkBuffer<InnerNode48, 16> inner_nodes_48;
    /// The inner nodes with capacity 256
    ChunkBuffer<InnerNode256, 16> inner_nodes_256;

    /// Visit all entries in a subtree
    static void VisitAll(Node *node, IterationCallback callback, ContextType context);

   public:
    /// Access entries
    auto &GetEntries() const { return entries; }
    /// Iterates through the entries in the map that match a given prefix.
    void IteratePrefix(std::string_view prefix, IterationCallback callback, ContextType context);

    /// Bulkload a suffix trie from a name dictionary
    static std::unique_ptr<SuffixTrie> BulkLoad(std::span<std::string_view> names);
    /// Bulkload a suffix trie from a name dictionary
    static std::unique_ptr<SuffixTrie> BulkLoad(std::span<std::pair<std::string_view, proto::Location>> names);
};

}  // namespace flatsql
