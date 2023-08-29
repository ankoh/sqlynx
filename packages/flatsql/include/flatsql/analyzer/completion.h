#pragma once

#include "flatsql/analyzer/analyzer.h"
#include "flatsql/parser/grammar/keywords.h"
#include "flatsql/script.h"
#include "flatsql/utils/suffix_trie.h"

namespace flatsql {

struct CompletionIndex {
    /// The suffix trie
    std::unique_ptr<SuffixTrie> suffix_trie = nullptr;
    /// The analyzed script
    std::shared_ptr<AnalyzedScript> analyzed_script = nullptr;

    /// Constructor
    CompletionIndex(std::unique_ptr<SuffixTrie> trie, std::shared_ptr<AnalyzedScript> script = nullptr);

    /// Construct completion index from keywords
    static std::unique_ptr<CompletionIndex> Build(std::span<const parser::Keyword> keywords);
    /// Construct completion index from script
    static std::unique_ptr<CompletionIndex> Build(std::shared_ptr<AnalyzedScript> script);
};

}  // namespace flatsql
