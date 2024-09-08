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
    using ScoringTable = std::array<std::pair<proto::NameTag, ScoreValueType>, 8>;

    static constexpr ScoreValueType TAG_IGNORE = 0;
    static constexpr ScoreValueType TAG_UNLIKELY = 10;
    static constexpr ScoreValueType TAG_LIKELY = 20;
    static constexpr ScoreValueType KEYWORD_VERY_POPULAR = 3;
    static constexpr ScoreValueType KEYWORD_POPULAR = 2;
    static constexpr ScoreValueType KEYWORD_DEFAULT = 0;

    static constexpr ScoreValueType SUBSTRING_SCORE_MODIFIER = 15;
    static constexpr ScoreValueType PREFIX_SCORE_MODIFIER = 20;
    static constexpr ScoreValueType RESOLVING_TABLE_SCORE_MODIFIER = 2;
    static constexpr ScoreValueType UNRESOLVED_PEER_SCORE_MODIFIER = 2;
    static constexpr ScoreValueType DOT_SCHEMA_SCORE_MODIFIER = 2;
    static constexpr ScoreValueType DOT_TABLE_SCORE_MODIFIER = 2;

    static_assert(PREFIX_SCORE_MODIFIER > SUBSTRING_SCORE_MODIFIER,
                  "Begin a prefix weighs more than being a substring");
    static_assert((TAG_UNLIKELY + SUBSTRING_SCORE_MODIFIER) > TAG_LIKELY,
                  "An unlikely name that is a substring outweighs a likely name");
    static_assert((TAG_UNLIKELY + KEYWORD_VERY_POPULAR) < TAG_LIKELY,
                  "A very likely keyword prevalance doesn't outweigh a likely tag");

    /// A bitset for candidate tags
    using CandidateTags = EnumBitset<uint16_t, proto::CandidateTag, proto::CandidateTag::MAX>;
    /// The completion candidates
    struct Candidate {
        /// The name
        std::string_view name;
        /// The combined name tags.
        /// We may hit the same name multiple times in multiple catalog entries.
        /// Each of these entries may have different name tags, so we have to merge them here.
        NameTags name_tags;
        /// The combined candidate tags
        CandidateTags candidate_tags;
        /// The name score
        ScoreValueType score = 0;
        /// The catalog objects
        std::vector<std::reference_wrapper<const CatalogObject>> catalog_objects;
        /// Replace text at a location
        sx::Location replace_text_at;

        /// Get the score
        inline ScoreValueType GetScore() const { return score; }
        /// Is less in the min-heap?
        /// We want to kick a candidate A before candidate B if
        ///     1) the score of A is less than the score of B
        ///     2) the name of A is lexicographically larger than B
        bool operator<(const Candidate& other) const {
            auto l = GetScore();
            auto r = other.GetScore();
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
    /// The scoring table
    const ScoringTable& scoring_table;
    /// The hash-map to deduplicate names found in the completion indexes
    CandidateMap pending_candidates;
    /// The result heap, holding up to k entries
    TopKHeap<Candidate> result_heap;

    /// Read the name path of the current cursor
    std::vector<Completion::NameComponent> ReadCursorNamePath(sx::Location& name_path_loc) const;
    /// Complete after a dot
    void FindCandidatesForNamePath();
    /// Find the candidates in completion indexes
    void FindCandidatesInIndexes();
    /// Promote expected symbols in the grammar
    void PromoteExpectedGrammarSymbols(std::span<parser::Parser::ExpectedSymbol> symbols);
    /// Promote tables that contain column names that are still unresolved in the current statement
    void PromoteTablesAndPeersForUnresolvedColumns();
    /// Flush pending candidates and finish the results
    void FlushCandidatesAndFinish();

   public:
    /// Constructor
    Completion(const ScriptCursor& cursor, size_t k);

    /// Get the cursor
    auto& GetCursor() const { return cursor; }
    /// Get the completion strategy
    auto& GetStrategy() const { return strategy; }
    /// Get the scoring table
    auto& GetScoringTable() const { return scoring_table; }
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
