#include "flatsql/analyzer/completion.h"

#include "flatsql/parser/grammar/keywords.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/script.h"
#include "flatsql/utils/suffix_trie.h"

namespace flatsql {

CompletionIndex::CompletionIndex(std::unique_ptr<SuffixTrie> trie, std::shared_ptr<AnalyzedScript> script)
    : suffix_trie(std::move(trie)), analyzed_script(std::move(script)) {}

std::unique_ptr<CompletionIndex> CompletionIndex::Build(std::shared_ptr<AnalyzedScript> script) {
    auto& parsed = script->parsed_script;
    auto& scanned = parsed->scanned_script;
    auto& names = scanned->name_dictionary;
    auto trie = SuffixTrie::BulkLoad(names, [&](size_t i, auto& name) { return SuffixTrie::Entry{name.text, 0, 0}; });
    return std::make_unique<CompletionIndex>(std::move(trie), std::move(script));
}

const CompletionIndex& CompletionIndex::Keywords() {
    static std::unique_ptr<const CompletionIndex> index = nullptr;
    // Already initialized?
    if (index != nullptr) {
        return *index;
    }
    // If not, load keywords
    auto keywords = parser::Keyword::GetKeywords();
    auto trie = SuffixTrie::BulkLoad(keywords, [&](uint64_t i, const parser::Keyword& keyword) {
        return SuffixTrie::Entry{keyword.name, i, proto::NameTag::KEYWORD};
    });
    index = std::make_unique<CompletionIndex>(std::move(trie));
    return *index;
}

}  // namespace flatsql
