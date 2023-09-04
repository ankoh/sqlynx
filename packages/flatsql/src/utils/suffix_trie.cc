#include "flatsql/utils/suffix_trie.h"

#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <stack>
#include <tuple>

#include "flatsql/proto/proto_generated.h"

namespace flatsql {

size_t SuffixTrie::Node::Match(StringView prefix) {
    size_t limit = std::min<size_t>(key.size(), prefix.size());
    size_t i = 0;
    for (; i < limit && tolower(key[i]) == tolower(prefix[i]); ++i)
        ;
    return i;
}

SuffixTrie::InnerNode4::InnerNode4(StringView partial) : Node(NodeType::InnerNode4, partial) {
    std::memset(child_keys.data(), 0, child_keys.size() * sizeof(unsigned char));
    std::memset(children.data(), 0, children.size() * sizeof(void *));
}

SuffixTrie::InnerNode16::InnerNode16(StringView partial) : Node(NodeType::InnerNode16, partial) {
    std::memset(child_keys.data(), 0, child_keys.size() * sizeof(unsigned char));
    std::memset(children.data(), 0, children.size() * sizeof(void *));
}

SuffixTrie::InnerNode48::InnerNode48(StringView partial) : Node(NodeType::InnerNode48, partial) {
    std::memset(child_ids.data(), 0, child_ids.size() * sizeof(unsigned char));
    std::memset(children.data(), 0, children.size() * sizeof(void *));
}

SuffixTrie::InnerNode256::InnerNode256(StringView partial) : Node(NodeType::InnerNode256, partial) {
    std::memset(children.data(), 0, children.size() * sizeof(void *));
}

SuffixTrie::Node *SuffixTrie::InnerNode4::Find(unsigned char c) {
    c = tolower(c);
    size_t scratch[4];
    size_t *writer = scratch;
    *writer = 0;
    writer += child_keys[0] == c;
    *writer = 1;
    writer += child_keys[1] == c;
    *writer = 2;
    writer += child_keys[2] == c;
    *writer = 3;
    return children[scratch[0]];
}

SuffixTrie::Node *SuffixTrie::InnerNode16::Find(unsigned char c) {
    c = tolower(c);
    size_t scratch[16];
    size_t *writer = scratch;
    for (size_t i = 0; i < 16; ++i) {
        *writer = i;
        writer += child_keys[i] == c;
    }
    return children[scratch[0]];
}

void SuffixTrie::VisitAll(Node *n, IterationCallback callback, ContextType context) {
    if (!n) return;

    std::stack<SuffixTrie::Node *> pending;
    pending.push(n);

    while (!pending.empty()) {
        n = pending.top();
        pending.pop();
        switch (n->node_type) {
            case SuffixTrie::NodeType::LeafNode: {
                auto &leaf = *static_cast<LeafNode *>(n);
                callback(context, leaf.entries);
                break;
            }
            case SuffixTrie::NodeType::InnerNode4: {
                auto &inner = *static_cast<InnerNode4 *>(n);
                for (size_t i = 0; i < inner.children.size(); ++i) {
                    if (auto ptr = *(inner.children.rbegin() + i)) {
                        pending.push(ptr);
                    }
                }
                break;
            }
            case SuffixTrie::NodeType::InnerNode16: {
                auto &inner = *static_cast<InnerNode16 *>(n);
                for (size_t i = 0; i < inner.children.size(); ++i) {
                    if (auto ptr = *(inner.children.rbegin() + i)) {
                        pending.push(ptr);
                    }
                }
                break;
            }
            case SuffixTrie::NodeType::InnerNode48: {
                auto &inner = *static_cast<InnerNode48 *>(n);
                for (size_t i = 0; i < 256; ++i) {
                    size_t child_id = *(inner.child_ids.rbegin() + i);
                    if (child_id != 0) {
                        pending.push(*(inner.children.rbegin() + (child_id - 1)));
                    }
                }
                break;
            }
            case SuffixTrie::NodeType::InnerNode256: {
                auto &inner = *static_cast<InnerNode256 *>(n);
                for (size_t i = 0; i < 256; ++i) {
                    Node *child = *(inner.children.rbegin() + i);
                    if (child != nullptr) {
                        pending.push(child);
                    }
                }
                break;
            }
            case NodeType::None:
                abort();
        }
    }
}

void SuffixTrie::IteratePrefix(StringView query, IterationCallback callback, ContextType context) {
    Node *node = root;
    size_t depth = 0;
    while (node) {
        // Reached a leaf?
        if (node->node_type == NodeType::LeafNode) {
            LeafNode &leaf = *static_cast<LeafNode *>(node);
            if (auto match = leaf.Match(query); match == query.size()) {
                callback(context, leaf.entries);
            }
            return;
        }

        // Match the partical key
        auto key_tail = query.substr(depth);
        size_t match = node->Match(key_tail);
        depth += match;

        // Matched full query string?
        if (depth == query.size()) {
            return VisitAll(node, callback, context);
        }

        // Didn't match the full query string, did we match the full inner key?
        // Traverse one level down.
        if (match == node->key.size()) {
            switch (node->node_type) {
                case NodeType::InnerNode4:
                    node = static_cast<InnerNode4 *>(node)->Find(query[depth++]);
                    continue;
                case NodeType::InnerNode16:
                    node = static_cast<InnerNode16 *>(node)->Find(query[depth++]);
                    continue;
                case NodeType::InnerNode48:
                    node = static_cast<InnerNode48 *>(node)->Find(query[depth++]);
                    continue;
                case NodeType::InnerNode256:
                    node = static_cast<InnerNode256 *>(node)->Find(query[depth++]);
                    continue;
                case NodeType::None:
                case NodeType::LeafNode:
                    abort();
                    break;
            }
        }

        // Otherwise there must be a prefix mismatch.
        assert(match < node->key.size() && match < query.size());
        return;
    }
}

constexpr unsigned char SUFFIX_END_MARKER = '\0';
// Apple lacks memicmp
static_assert(std::string_view("ab") < std::string_view("ab\0", 3));
static_assert(std::string_view("ab\0", 3) < std::string_view("abA"));
static_assert(std::string_view("ab\0", 3) < std::string_view("ab0"));
static_assert(std::string_view("ab\0", 3) < std::string_view("ab\0a", 4));

std::unique_ptr<SuffixTrie> SuffixTrie::BulkLoad(std::vector<Entry> entries) {
    assert(std::is_sorted(entries.begin(), entries.end(), [&](auto &l, auto &r) { return l.suffix < r.suffix; }));

    // Create trie
    auto trie = std::make_unique<SuffixTrie>();
    trie->entries = std::move(entries);
    if (trie->entries.empty()) {
        return trie;
    }

    // Partition based on the first character
    std::vector<std::span<Entry>> partitions;
    std::vector<unsigned char> partition_keys;
    partitions.resize(256, {});
    partition_keys.reserve(256);

    /// Helper to partition a range of entries
    auto partition_range = [](std::vector<std::span<Entry>> &partitions, std::vector<unsigned char> &partition_keys,
                              std::span<Entry> nodes, size_t prefix_begin) {
        auto begin = nodes.begin();
        while (begin != nodes.end()) {
            // Does the partition key equal the prefix? In that case we emit a leaf directly.
            if (begin->suffix.size() <= prefix_begin) {
                auto end = std::partition_point(begin, nodes.end(),
                                                [prefix_begin](Entry &e) { return e.suffix.size() <= prefix_begin; });
                assert(partitions[SUFFIX_END_MARKER].empty());
                partitions[SUFFIX_END_MARKER] = {begin, end};
                begin = end;
                partition_keys.push_back(SUFFIX_END_MARKER);
            } else {
                unsigned char key = tolower(begin->suffix[prefix_begin]);
                auto end = std::partition_point(begin, nodes.end(), [key, prefix_begin](Entry &e) {
                    return e.suffix.size() <= prefix_begin || tolower(e.suffix[prefix_begin]) == key;
                });

                // We use \0 as the end marker to exploit the default string comparison.
                // Strings terminated with \0 immediately follow strings with the same prefix but one less character.
                // When processing the partitions, we can collect all prefix entries and merge them with all entries
                // that end in \0.
                // When choosing a different character, we have to special-case end marker partition keys.
                if (key == SUFFIX_END_MARKER && !partitions[SUFFIX_END_MARKER].empty()) {
                    assert(partitions[SUFFIX_END_MARKER].end() == begin);
                    partitions[key] = {partitions[key].begin(), end};
                } else {
                    assert(partitions[key].empty());
                    partitions[key] = {begin, end};
                    partition_keys.push_back(key);
                }
                begin = end;
            }
        }
    };

    // Get the common prefix between two strings
    auto common_prefix = [](StringView left, StringView right) {
        size_t limit = std::min(left.size(), right.size());
        size_t prefix_len = 0;
        for (; prefix_len < limit && tolower(left[prefix_len]) == tolower(right[prefix_len]); ++prefix_len)
            ;
        return left.substr(0, prefix_len);
    };

    /// Track pending entries
    std::stack<std::tuple<Node *&, std::span<Entry>, size_t>> pending;
    pending.emplace(trie->root, trie->entries, 0);

    do {
        auto [this_ref, partition, depth] = pending.top();
        pending.pop();
        assert(!partition.empty());

        // Find a shared prefix among the entries (if there is any)
        StringView first_suffix = partition.front().suffix;
        StringView first = first_suffix.size() <= depth ? "\0" : first_suffix.substr(depth);
        StringView last_suffix = partition.back().suffix;
        StringView last = last_suffix.size() <= depth ? "\0" : last_suffix.substr(depth);
        StringView partial = common_prefix(first, last);
        depth += partial.size();

        // Partition all entries
        partition_keys.clear();
        partition_range(partitions, partition_keys, partition, depth);
        auto partition_count = partition_keys.size();

        if (partition_count == 1) {
            // There's only one partition left even though we cut a prefix.
            // That means we either hit the end or there are only string left with \0 as next character
            auto suffix = partition[0].suffix;
            LeafNode &node = trie->leaf_nodes.Append(LeafNode(suffix, partition));
            partitions[suffix.size() <= depth ? SUFFIX_END_MARKER : tolower(suffix[depth])] = {};
            this_ref = &node;

        } else if (partition_count <= 4) {
            InnerNode4 &node = trie->inner_nodes_4.Append(InnerNode4(partial));
            std::memcpy(node.child_keys.data(), partition_keys.data(), partition_count * sizeof(unsigned char));
            for (size_t i = 0; i < partition_count; ++i) {
                unsigned char key = partition_keys[i];
                pending.push({node.children[i], partitions[key], depth + 1});  // XXX prefix_begin +1?
                partitions[key] = {};
            }
            this_ref = &node;

        } else if (partition_count <= 16) {
            InnerNode16 &node = trie->inner_nodes_16.Append(InnerNode16(partial));
            std::memcpy(node.child_keys.data(), partition_keys.data(), partition_count * sizeof(unsigned char));
            for (size_t i = 0; i < partition_count; ++i) {
                unsigned char key = partition_keys[i];
                pending.push({node.children[i], partitions[key], depth + 1});  // XXX prefix_begin +1?
                partitions[key] = {};
            }
            this_ref = &node;

        } else if (partition_count <= 48) {
            InnerNode48 &node = trie->inner_nodes_48.Append(InnerNode48(partial));
            node.num_children = partition_count;
            for (size_t i = 0; i < partition_count; ++i) {
                node.child_ids[partition_keys[i]] = i;
            }
            for (size_t i = 0; i < partition_count; ++i) {
                unsigned char key = partition_keys[i];
                pending.push({node.children[i], partitions[key], depth + 1});  // XXX prefix_begin +1?
                partitions[key] = {};
            }
            this_ref = &node;

        } else {
            InnerNode256 &node = trie->inner_nodes_256.Append(InnerNode256(partial));
            for (auto key : partition_keys) {
                pending.push({node.children[key], partitions[key], depth + 1});  // XXX prefix_begin +1?
                partitions[key] = {};
            }
            this_ref = &node;
        }
    } while (!pending.empty());

    return trie;
}

}  // namespace flatsql
