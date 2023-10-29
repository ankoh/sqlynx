#pragma once

#include "ankerl/unordered_dense.h"
#include "sqlynx/analyzer/completion_index.h"
#include "sqlynx/context.h"
#include "sqlynx/parser/names.h"
#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/script.h"
#include "sqlynx/utils/string_conversion.h"
#include "sqlynx/utils/suffix_trie.h"
#include "sqlynx/utils/topk.h"

namespace sqlynx {

/// For now, we want the completion to work as follows:
///
/// 1) We first resolve the current scanner position and collect all symbols the parser would have expected.
///    All symbols that are NOT identifiers are written directly into the result heap,
///    If IDENT is NOT INCLUDED in the expected symbols, we stop the completion and return the the result heap.
/// 2) We then derive a score function for the current cursor.
///     - If we are in a TABLE_REF clause, database/schema/table names score higher based on the path length.
///     - If we are in an COLUMN_REF, column names score higher.
///     - If we are in a SELECT clause, column names score higher.
///     - ... other rules that make sense
/// 3) We then collect ALL the names that we found using the suffix lookup.
///     - We create a dense hash-table and reserve space for min(suffix_count, name_dictionary_size) entries.
///     - We store all names as QualifiedIDs in the hash table since we have to deduplicate them anyway.
///     - We use the name tags to add a first score based on the score function.
/// 4) We then discover all other relevant names using the cursor
///     - We find all table refs that belong to our statement id.
///     - For these table refs, we find all column names.
///     - We find all possible table names for unresolved column refs.
///     - For these table refs, we find all column names.
///     - We find all column aliases of that statement id
/// 5) We lookup each of the names discovered in 3) in our map and add additional score
/// 6) We then construct a max-heap to determine the top-k names with highest score
/// 7) Those are returned to the user
///
/// One may argue that the scoring in 3) and 4) are slightly redundant:
/// The reason why we split the two is the way people write SQL. For a prefix like `SELECT * FROM f`, we don't have
/// any information except that we are in a potential table_ref. We therefore need a way to prefer table names even
/// though we don't have any information to narrow them down further. Thus the "tagging" of names in the name
/// dictionaries. However, for a query like `SELECT bar FROM f`, we know of an unresolved column ref that lets a table
/// with name `foo` containing such a column score even higher than other table names.

struct Completion {
    using ScoreValueType = uint32_t;
    using ScoringTable = std::array<std::pair<proto::NameTag, ScoreValueType>, 8>;

    /// The completion candidates
    struct Candidate {
        /// The name text
        std::string_view name_text;
        /// The name tags
        NameTags name_tags;
        /// The name score
        ScoreValueType score;
        /// The number of times we hit this name
        size_t occurences_in_script;
        /// Is a name in the statement scope?
        bool in_statement_scope;
    };
    /// A hash-map for candidates
    using CandidateMap = ankerl::unordered_dense::map<QualifiedID, Candidate, QualifiedID::Hasher>;

   protected:
    /// The script cursor
    const ScriptCursor& cursor;
    /// The scoring table
    const ScoringTable& scoring_table;
    /// The hash-map to deduplicate names found in the completion indexes
    CandidateMap pending_candidates;
    /// The result heap, holding up to k entries
    TopKHeap<Candidate, ScoreValueType> result_heap;

    /// Resolve the expected symbols
    void FindCandidatesInGrammar(bool& expects_identifier);
    /// Find the candidates in a completion index
    void FindCandidatesInIndex(const CompletionIndex& index);
    /// Find the candidates in completion indexes
    void FindCandidatesInIndexes();
    /// Find candidates in the AST around the script cursor
    void FindCandidatesInAST();
    /// Flush pending candidates and finish the results
    void FlushCandidatesAndFinish();

   public:
    /// Constructor
    Completion(const ScriptCursor& cursor, size_t k);

    /// Get the result heap
    auto& GetHeap() const { return result_heap; }
    /// Pack the completion result
    flatbuffers::Offset<proto::Completion> Pack(flatbuffers::FlatBufferBuilder& builder);
    // Compute completion at a cursor
    static std::pair<std::unique_ptr<Completion>, proto::StatusCode> Compute(const ScriptCursor& cursor, size_t k);
};

}  // namespace sqlynx
