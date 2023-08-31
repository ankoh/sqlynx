#pragma once

#include "flatsql/proto/proto_generated.h"
#include "flatsql/utils/suffix_trie.h"

namespace flatsql {

struct AnalyzedScript;

struct CompletionIndex {
    /// The suffix trie
    std::unique_ptr<SuffixTrie> suffix_trie = nullptr;
    /// The analyzed script
    std::shared_ptr<AnalyzedScript> analyzed_script = nullptr;

    /// Constructor
    CompletionIndex(std::unique_ptr<SuffixTrie> trie, std::shared_ptr<AnalyzedScript> script = nullptr);

    /// Construct completion index from script
    static std::unique_ptr<CompletionIndex> Build(std::shared_ptr<AnalyzedScript> script);
    /// Get the static keyword index
    static const CompletionIndex& Keywords();
};

}  // namespace flatsql
