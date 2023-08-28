#pragma once

#include "flatsql/analyzer/analyzer.h"
#include "flatsql/parser/grammar/keywords.h"
#include "flatsql/utils/suffix_trie.h"

namespace flatsql {

struct CompletionIndex {
    /// The suffix trie
    std::unique_ptr<SuffixTrie> suffix_trie = nullptr;
    /// The analyzed script
    std::shared_ptr<AnalyzedScript> analyzed_script = nullptr;
};

}  // namespace flatsql
