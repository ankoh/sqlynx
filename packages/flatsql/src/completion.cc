#include "flatsql/analyzer/completion.h"

#include "flatsql/utils/suffix_trie.h"

namespace flatsql {

CompletionIndex::CompletionIndex(std::unique_ptr<SuffixTrie> trie, std::shared_ptr<AnalyzedScript> script)
    : suffix_trie(std::move(trie)), analyzed_script(std::move(script)) {}

std::unique_ptr<CompletionIndex> CompletionIndex::Build(std::span<const parser::Keyword> keywords) {
    auto trie = SuffixTrie::BulkLoad(keywords, [](auto& k) { return k.name; });
    return std::make_unique<CompletionIndex>(std::move(trie));
}

std::unique_ptr<CompletionIndex> CompletionIndex::Build(std::shared_ptr<AnalyzedScript> script) {
    auto& parsed = script->parsed_script;
    auto& scanned = parsed->scanned_script;
    auto& names = scanned->name_dictionary;
    auto trie = SuffixTrie::BulkLoad(names);
    return std::make_unique<CompletionIndex>(std::move(trie), std::move(script));
}

}  // namespace flatsql
