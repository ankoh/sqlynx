#pragma once

#include "dashql/catalog_object.h"
#include "dashql/buffers/index_generated.h"
#include "dashql/script.h"
#include "dashql/utils/enum_bitset.h"
#include "dashql/utils/topk.h"

namespace dashql {

struct Completion {
    /// A score value
    using ScoreValueType = uint32_t;
    /// A bitset for candidate tags
    using CandidateTags = EnumBitset<uint16_t, buffers::CandidateTag, buffers::CandidateTag::MAX>;

    struct Candidate;
    /// A catalog object referenced by a completion candidate
    struct CandidateCatalogObject : public IntrusiveListNode {
        /// The candidate
        Candidate& candidate;
        /// The candidate tags of this object
        CandidateTags candidate_tags;
        /// The catalog object
        const CatalogObject& catalog_object;
        /// The score (if computed)
        ScoreValueType score = 0;
    };
    /// A completion candidate
    struct Candidate {
        /// The name
        std::string_view name;
        /// The combined coarse-granular analyzer tags.
        /// We may hit the same name multiple times in multiple catalog entries.
        /// Each of these entries may have different name tags, so we have to merge them here.
        NameTags coarse_name_tags;
        /// The combined more fine-granular candidate tags
        CandidateTags candidate_tags;
        /// Replace text at a location
        sx::Location replace_text_at;
        /// The catalog objects
        IntrusiveList<CandidateCatalogObject> catalog_objects;
        /// The score (if computed)
        ScoreValueType score = 0;
        /// Is less in the min-heap?
        /// We want to kick a candidate A before candidate B if
        ///     1) the score of A is less than the score of B
        ///     2) the name of A is lexicographically larger than B
        bool operator<(const Candidate& other) const {
            auto l = score;
            auto r = other.score;
            return (l < r) || (l == r && (fuzzy_ci_string_view{name.data(), name.size()} >
                                          fuzzy_ci_string_view{other.name.data(), other.name.size()}));
        }
    };

    /// A name component type
    enum NameComponentType { Name, Star, TrailingDot, Index };
    /// A name component
    struct NameComponent {
        /// The location
        sx::Location loc;
        /// The component type
        NameComponentType type;
        /// The name (if any)
        std::optional<std::reference_wrapper<RegisteredName>> name;
    };

    /// Helper to find candidates in an index
    void findCandidatesInIndex(const CatalogEntry::NameSearchIndex& index, bool through_catalog);

   protected:
    /// The script cursor
    const ScriptCursor& cursor;
    /// The completion strategy
    const buffers::CompletionStrategy strategy;

    /// The candidate buffer
    ChunkBuffer<Candidate, 16> candidates;
    /// The candidate object buffer
    ChunkBuffer<CandidateCatalogObject, 16> candidate_objects;
    /// The candidates by name
    std::unordered_map<std::string_view, std::reference_wrapper<Candidate>> candidates_by_name;
    /// The candidate objects by object.
    /// We use this for promoting individual candidates.
    /// Note that this assumes that a catalog object can be added to at most a single candidate.
    std::unordered_map<const CatalogObject*, std::reference_wrapper<CandidateCatalogObject>>
        candidate_objects_by_object;

    /// The result heap, holding up to k entries
    TopKHeap<Candidate> result_heap;

    /// Read the name path of the current cursor
    std::vector<Completion::NameComponent> ReadCursorNamePath(sx::Location& name_path_loc) const;
    /// Complete after a dot
    void FindCandidatesForNamePath();
    /// Find the candidates in completion indexes
    void FindCandidatesInIndexes();
    /// Promote tables that contain column names that are still unresolved in the current statement
    void PromoteTablesAndPeersForUnresolvedColumns();
    /// Add expected keywords in the grammar directly to the result heap.
    /// We deliberately do not register them as candidates to not inflate the results.
    /// We accept that they may occur twice in the completion list and we mark them explictly as grammar matches in the
    /// UI.
    void AddExpectedKeywordsAsCandidates(std::span<parser::Parser::ExpectedSymbol> symbols);
    /// Flush pending candidates and finish the results
    void FlushCandidatesAndFinish();

   public:
    /// Constructor
    Completion(const ScriptCursor& cursor, size_t k);

    /// Get the cursor
    auto& GetCursor() const { return cursor; }
    /// Get the completion strategy
    auto& GetStrategy() const { return strategy; }
    /// Get the result heap
    auto& GetHeap() const { return result_heap; }

    /// Pack the completion result
    flatbuffers::Offset<buffers::Completion> Pack(flatbuffers::FlatBufferBuilder& builder);
    // Compute completion at a cursor
    static std::pair<std::unique_ptr<Completion>, buffers::StatusCode> Compute(const ScriptCursor& cursor, size_t k);
};

}  // namespace dashql
