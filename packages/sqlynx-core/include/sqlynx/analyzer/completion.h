#pragma once

#include "ankerl/unordered_dense.h"
#include "sqlynx/catalog_object.h"
#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/script.h"
#include "sqlynx/utils/enum_bitset.h"
#include "sqlynx/utils/topk.h"

namespace sqlynx {

struct Completion {
    using ScoreValueType = uint32_t;

    // Coarse base score of a registered name
    static constexpr ScoreValueType NAME_TAG_IGNORE = 0;
    static constexpr ScoreValueType NAME_TAG_UNLIKELY = 10;
    static constexpr ScoreValueType NAME_TAG_LIKELY = 20;

    // Keywork prevalence modifiers
    // Users write some keywords much more likely than others, and we hardcode some prevalence scores.
    static constexpr ScoreValueType KEYWORD_VERY_POPULAR = 3;
    static constexpr ScoreValueType KEYWORD_POPULAR = 2;
    static constexpr ScoreValueType KEYWORD_DEFAULT = 0;

    // Fine-granular score modifiers
    static constexpr ScoreValueType SUBSTRING_SCORE_MODIFIER = 15;
    static constexpr ScoreValueType PREFIX_SCORE_MODIFIER = 20;
    static constexpr ScoreValueType RESOLVING_TABLE_SCORE_MODIFIER = 2;
    static constexpr ScoreValueType UNRESOLVED_PEER_SCORE_MODIFIER = 2;
    static constexpr ScoreValueType DOT_SCHEMA_SCORE_MODIFIER = 2;
    static constexpr ScoreValueType DOT_TABLE_SCORE_MODIFIER = 2;
    static constexpr ScoreValueType DOT_COLUMN_SCORE_MODIFIER = 2;

    static_assert(PREFIX_SCORE_MODIFIER > SUBSTRING_SCORE_MODIFIER,
                  "Begin a prefix weighs more than being a substring");
    static_assert((NAME_TAG_UNLIKELY + SUBSTRING_SCORE_MODIFIER) > NAME_TAG_LIKELY,
                  "An unlikely name that is a substring outweighs a likely name");
    static_assert((NAME_TAG_UNLIKELY + KEYWORD_VERY_POPULAR) < NAME_TAG_LIKELY,
                  "A very likely keyword prevalance doesn't outweigh a likely tag");

    /// A bitset for candidate tags
    using CandidateTags = EnumBitset<uint16_t, proto::CandidateTag, proto::CandidateTag::MAX>;

    /// The completion candidates
    struct Candidate {
        /// The name
        std::string_view name;
        /// The combined coarse-granular analyzer tags.
        /// We may hit the same name multiple times in multiple catalog entries.
        /// Each of these entries may have different name tags, so we have to merge them here.
        NameTags coarse_name_tags;
        /// The more fine-granular candidate tags
        CandidateTags candidate_tags;
        /// The catalog objects
        std::vector<std::reference_wrapper<const CatalogObject>> catalog_objects;
        /// Replace text at a location
        sx::Location replace_text_at;
    };

    struct CandidateWithScore : public Candidate {
        /// The computed score for the candidate
        ScoreValueType score;
        /// The constructor
        CandidateWithScore(Candidate c, ScoreValueType score) : Candidate(std::move(c)), score(score) {}

        /// Is less in the min-heap?
        /// We want to kick a candidate A before candidate B if
        ///     1) the score of A is less than the score of B
        ///     2) the name of A is lexicographically larger than B
        bool operator<(const CandidateWithScore& other) const {
            auto l = score;
            auto r = other.score;
            return (l < r) || (l == r && (fuzzy_ci_string_view{name.data(), name.size()} >
                                          fuzzy_ci_string_view{other.name.data(), other.name.size()}));
        }
    };

    /// A hash-map for candidates
    using CandidateMap = ankerl::unordered_dense::map<std::string_view, Candidate>;

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

   protected:
    /// The script cursor
    const ScriptCursor& cursor;
    /// The completion strategy
    const proto::CompletionStrategy strategy;
    /// The hash-map to deduplicate names found in the completion indexes
    CandidateMap pending_candidates;
    /// The result heap, holding up to k entries
    TopKHeap<CandidateWithScore> result_heap;

    /// Read the name path of the current cursor
    std::vector<Completion::NameComponent> ReadCursorNamePath(sx::Location& name_path_loc) const;
    /// Complete after a dot
    void FindCandidatesForNamePath();
    /// Find the candidates in completion indexes
    void FindCandidatesInIndexes();
    /// Promote tables that contain column names that are still unresolved in the current statement
    void PromoteTablesAndPeersForUnresolvedColumns();
    /// Add expected keywords in the grammar as completion candidates.
    /// We deliberately do not register them in the pending candidates map to not inflate the results.
    /// We accept that they may occur twice in the completion list since and mark them explictly as grammar matches.
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
    /// Get the pending candidates
    auto& GetPendingCandidates() { return pending_candidates; }
    /// Get the result heap
    auto& GetHeap() const { return result_heap; }

    /// Pack the completion result
    flatbuffers::Offset<proto::Completion> Pack(flatbuffers::FlatBufferBuilder& builder);
    // Compute completion at a cursor
    static std::pair<std::unique_ptr<Completion>, proto::StatusCode> Compute(const ScriptCursor& cursor, size_t k);
};

}  // namespace sqlynx
