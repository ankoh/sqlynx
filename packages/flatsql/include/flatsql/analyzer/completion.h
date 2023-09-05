#pragma once

#include "flatsql/context.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/script.h"
#include "flatsql/utils/string_conversion.h"
#include "flatsql/utils/suffix_trie.h"

namespace flatsql {

/// For now, we want the completion to work as follows:
///
/// 1) We first derive a score function for the current cursor.
///     - If we are in a TABLE_REF clause, database/schema/table names score higher based on the path length.
///     - If we are in an COLUMN_REF, column names score higher.
///     - If we are in a SELECT clause, column names score higher.
///     - ... other rules that make sense
/// 2) We then collect ALL the names that we found using the suffix lookup.
///     - We create a dense hash-table and reserve space for min(suffix_count, name_dictionary_size) entries.
///     - We store all names as QualifiedIDs in the hash table since we have to deduplicate them anyway.
///     - We use the name tags to add a first score based on the score function.
/// 3) We then discover all other relevant names using the cursor
///     - We find all table refs that belong to our statement id.
///     - For these table refs, we find all column names.
///     - We find all possible table names for unresolved column refs.
///     - For these table refs, we find all column names.
///     - We find all column aliases of that statement id
/// 4) We lookup each of the names discovered in 3) in our map and add additional score
/// 5) We then construct a max-heap to determine the top-k names with highest score
/// 6) Those are returned to the user
///
/// One may argue that the scoring in 2) and 4) are slightly redundant:
/// The reason why we split the two is the way people write SQL. For a prefix like `SELECT * FROM f`, we rarely have
/// any information except that we are in a potential table_ref. We therefore need a way to prefer table names even
/// though we don't have any information to narrow them down further. Thus the "tagging" of names in the name
/// dictionaries. However, for a query like `SELECT bar FROM f`, we know of an unresolved column ref that lets a table
/// with name `foo` score even higher than other table names.

struct CompletionState {
    /// XXX
};

class CompletionIndex {
   public:
    using StringView = fuzzy_ci_string_view;

    /// An entry in the trie
    struct Entry {
        /// The suffix
        StringView suffix;
        /// The name id
        size_t value_id;
        /// The name tags
        NameTags tags;

        /// Constructor
        Entry(StringView suffix = "", size_t value_id = 0, NameTags tags = 0)
            : suffix(suffix), value_id(value_id), tags(tags) {}
        /// Constructor
        Entry(std::string_view suffix, size_t value_id = 0, NameTags tags = 0)
            : suffix(suffix.data(), suffix.length()), value_id(value_id), tags(tags) {}
    };

    /// Constructor
    CompletionIndex(std::vector<Entry> entries, std::shared_ptr<AnalyzedScript> script = nullptr);

   protected:
    /// The entries sorted by suffix
    std::vector<Entry> entries;
    /// The analyzed script
    std::shared_ptr<AnalyzedScript> script;

    /// Find all entries that share a prefix
    std::span<Entry> FindEntriesWithPrefix(StringView prefix);

   public:
    /// Get the entries
    const auto& GetEntries() const { return entries; }
    /// Get the script
    const auto& GetScript() const { return script; }
    /// Get completions at a script cursor
    proto::StatusCode CompleteAt(const ScriptCursor& cursor, CompletionState& state);

    /// Construct completion index from script
    static std::pair<std::unique_ptr<CompletionIndex>, proto::StatusCode> Build(std::shared_ptr<AnalyzedScript> script);
    /// Get the static keyword index
    static const CompletionIndex& Keywords();
};

}  // namespace flatsql
