/*
   This file contains parts of a generated bison parser for our SQL grammar.
   As such, we're bound to the licensing of BISON which itself is GPL.
   Bison includes a specific exception for the BISON-generated output.

   https://cgit.git.savannah.gnu.org/cgit/bison.git/tree/data/yacc.c?id=193d7c7054ba7197b0789e14965b739162319b5e#n141

   "
   As a special exception, you may create a larger work that contains
   part or all of the Bison parser skeleton and distribute that work
   under terms of your choice, so long as that work isn't itself a
   parser generator using the skeleton or a modified version thereof
   as a parser skeleton.  Alternatively, if you modify or redistribute
   the parser skeleton itself, you may (at your option) remove this
   special exception, which will cause the skeleton and the resulting
   Bison output files to be licensed under the GNU General Public
   License without this special exception.

   This special exception was added by the Free Software Foundation in
   version 2.2 of Bison.
   "
*/

#include "dashql/parser/parser.h"

#include <algorithm>
#include <array>
#include <cassert>
#include <cctype>
#include <string>

#include "dashql/parser/parse_context.h"
#include "dashql/parser/parser_generated.h"
#include "dashql/utils/chunk_buffer.h"

namespace dashql::parser {

void dashql::parser::ParserBase::error(const location_type& loc, const std::string& message) {
    ctx.AddError(loc, message);
}

void Parser::error(const location_type& loc, const std::string& message) {
    ctx.AddError(loc, message, std::move(ctx.pending_hint));
    ctx.pending_hint.clear();
}

std::string Parser::yysyntax_error_(const context& yyctx) const {
    // Build the standard bison message first.
    std::string message = ParserBase::yysyntax_error_(yyctx);
    // If the offending token is a string literal but an identifier would have been valid here,
    // suggest the user double-quote it instead. Catches mistakes like `SELECT 1 AS 'one'` against
    // `sql_col_id` rules that only accept `IDENT`.
    if (yyctx.token() == symbol_kind::S_SCONST && yy_lac_check_(symbol_kind::S_IDENT)) {
        ctx.pending_hint = "string literals cannot be used as identifiers here; use a double-quoted identifier instead";
    } else {
        ctx.pending_hint.clear();
    }
    return message;
}

template <typename Base> static void destroy(std::string_view msg, dashql::parser::Parser::basic_symbol<Base>& yysym) {
    // See yy_destroy_
}

// Shared LALR driver — see DriveLALR below. The driver is a parallel copy of the bison-generated
// `parse()` skeleton (lalr1.cc) with four customization hooks delivered via a Policy duck type:
//
//   void Policy::OnLookaheadRead(Parser&, symbol_type& next,
//                                ChunkBuffer<...>::ConstTupleIterator pre_iter,
//                                uint32_t pre_token_index, bool& stop)
//     Called every time the loop has just read a token via NextSymbol() and is about to wrap it
//     in yyla. `pre_iter` and `pre_token_index` are the scanner's iterator state immediately
//     before NextSymbol() was called — policies use them to (a) test whether the next read is
//     at the cursor or (b) rewind so a different synthetic token can be re-read. The policy may
//     mutate `next` (e.g. overwrite kind/value to inject a synthetic token). Setting `stop = true`
//     aborts the driver immediately (used by ParsePrefixToTarget to snapshot at the cursor).
//
//   void Policy::OnShifted(Parser&, symbol_kind_type shifted_kind)
//     Called after every successful shift of the lookahead token. The probe uses this to count
//     post-cursor tokens that align with the grammar.
//
//   bool Policy::OnAccept(Parser&)
//     Called when the parser reaches its final state (yystack_[0].state == yyfinal_). Probe sets
//     reached_eof here. Return value is unused (kept for symmetry / future extension).
//
//   bool Policy::ShortCircuitOnError(Parser&)
//     Called at yyerrlab before standard error recovery. Returns true to stop the driver
//     immediately (e.g. probe stops once the candidate has shifted; collect-after stops once
//     COMPLETE_HERE has been fed and the parser errors at the post-feed state).
//
// Hooks that don't apply to a given policy should be no-ops returning sensible defaults.

/// Collect all expected symbols.
/// For each accepted keyword symbol, determines whether it is expected purely because it doubles as an
/// identifier (via sql_unreserved_keywords, sql_column_name_keywords, etc.) or because it has genuine
/// syntactic meaning at this position (e.g. CUBE in "GROUP BY CUBE(...)").
///
/// The heuristic: after shifting the keyword, check the target state's default action.
/// If it immediately reduces a length-1 rule, the keyword was only shifted into a keyword-list nonterminal
/// (like `sql_unreserved_keywords: BY {$$=$1;}`) and serves exclusively as an identifier.
/// Genuine keyword uses always lead to states expecting additional tokens (the keyword starts a multi-token
/// construct), so their target states do NOT have an immediate length-1 default reduce.
std::vector<Parser::ExpectedSymbol> Parser::CollectExpectedSymbols() {
    std::vector<Parser::ExpectedSymbol> expected;
    for (int yyx = 0; yyx < YYNTOKENS; ++yyx) {
        symbol_kind_type yysym = YY_CAST(symbol_kind_type, yyx);
        if (yysym != symbol_kind::S_YYerror && yysym != symbol_kind::S_YYUNDEF && yy_lac_check_(yysym)) {
            expected.emplace_back(yysym);
        }
    }
    return expected;
}

template <typename Policy> void Parser::DriveLALR(Policy& policy, bool init_stack) {
    // Completion probes replay this driver once per keyword candidate. A restored prefix can
    // enter a nullable reduction cycle that a regular parse never reaches; keep the bound small
    // enough that LAC cannot turn one completion request into unbounded work.
    constexpr size_t MAX_REDUCTIONS_WITHOUT_SHIFT = 128;
    // The next symbol id
    int yyn;
    // The length of the RHS of the rule being reduced
    int yylen = 0;
    // The error count
    [[maybe_unused]] int yynerrs_ = 0;
    // The error status
    int yyerrstatus_ = 0;
    /// The lookahead symbol
    symbol_type yyla;
    /// The locations where the error started and ended
    stack_symbol_type yyerror_range[3];
    /// The return value of parse ()
    [[maybe_unused]] int yyresult;
    size_t reductions_without_shift = 0;

    // Discard the LAC context in case there still is one left from a previous invocation.
    yy_lac_discard_("init");

    if (init_stack) {
        // Initialize the stack. The initial state will be set in yynewstate, since the latter
        // expects the semantical and the location values to have been already stored, initialize
        // these stacks with a primary value.
        yystack_.clear();
        yypush_(YY_NULLPTR, 0, YY_MOVE(yyla));
    }
    // Otherwise the caller (e.g. ProbeSuffixFromPrefix) has already restored a snapshot.

yynewstate:
    // Accept?
    if (yystack_[0].state == yyfinal_) {
        policy.OnAccept(*this);
        goto yyacceptlab;
    }
    goto yybackup;

yybackup:
    // Try to take a decision without lookahead.
    yyn = yypact_[+yystack_[0].state];
    if (yy_pact_value_is_default_(yyn)) goto yydefault;

    // Read a lookahead token.
    if (yyla.empty()) {
        // Snapshot the pre-read scanner state so policies can either (a) decide based on whether
        // the about-to-be-read token is at the cursor, or (b) rewind after deciding to inject a
        // synthetic token in place of the real one (probe's insert mode).
        auto pre_iter = ctx.GetSymbolIterator();
        auto pre_token_index = ctx.next_token_index;
        // Get the next symbol
        auto next_symbol = ctx.NextSymbol();
        // Let the policy inspect / mutate / replace the lookahead, or signal stop. Stop happens
        // when the policy wants to capture state at the cursor without consuming the token.
        bool stop = false;
        policy.OnLookaheadRead(*this, next_symbol, pre_iter, pre_token_index, stop);
        if (stop) goto yyabortlab;
        // Store symbol as lookahead
        symbol_type yylookahead(std::move(next_symbol));
        yyla.move(yylookahead);
    }

    if (yyla.kind() == symbol_kind::S_YYerror) {
        // The scanner already issued an error message, process directly to error recovery.
        // But do not keep the error token as lookahead, it is too special and may lead us
        // to an endless loop in error recovery.
        yyla.kind_ = symbol_kind::S_YYUNDEF;
        goto yyerrlab1;
    }

    // If the proper action on seeing token YYLA.TYPE is to reduce or to detect an error,
    // take that action.
    yyn += yyla.kind();
    if (yyn < 0 || yylast_ < yyn || yycheck_[yyn] != yyla.kind()) {
        if (!yy_lac_establish_(yyla.kind())) goto yyerrlab;
        goto yydefault;
    }

    // Reduce or error.
    yyn = yytable_[yyn];
    if (yyn <= 0) {
        if (yy_table_value_is_error_(yyn)) goto yyerrlab;
        if (!yy_lac_establish_(yyla.kind())) goto yyerrlab;
        yyn = -yyn;
        goto yyreduce;
    }

    // Count tokens shifted since error; after three, turn off error status.
    if (yyerrstatus_) --yyerrstatus_;

    // Shift the lookahead token.
    {
        auto shifted_kind = yyla.kind();
        yypush_("Shifting", state_type(yyn), YY_MOVE(yyla));
        yy_lac_discard_("shift");
        reductions_without_shift = 0;
        policy.OnShifted(*this, shifted_kind);
    }
    goto yynewstate;

yydefault:
    yyn = yydefact_[+yystack_[0].state];
    if (yyn == 0) goto yyerrlab;
    goto yyreduce;

yyreduce:
    // A restored completion snapshot can expose nullable grammar cycles that the regular parser
    // never enters. Stop the speculative replay instead of growing its state stack indefinitely.
    if (++reductions_without_shift > MAX_REDUCTIONS_WITHOUT_SHIFT) goto yyabortlab;
    yylen = yyr2_[yyn];
    {
        stack_symbol_type yylhs;
        yylhs.state = yy_lr_goto_state_(yystack_[yylen].state, yyr1_[yyn]);
        // Variants are always initialized to an empty instance of the correct type.
        // The default '$$ = $1' action is NOT applied when using variants.
        switch (yyr1_[yyn]) {
            default:
                break;
        }
        // Default location.
        {
            stack_type::slice range(yystack_, yylen);
            YYLLOC_DEFAULT(yylhs.location, range, yylen);
            yyerror_range[1].location = yylhs.location;
        }
        // Reductions (no-op: this driver doesn't run grammar actions).
        {
            switch (yyn) {
                default:
                    break;
            }
        }
        yypop_(yylen);
        yylen = 0;
        // Shift the result of the reduction.
        yypush_(YY_NULLPTR, YY_MOVE(yylhs));
    }
    goto yynewstate;

yyerrlab:
    // Give the policy a chance to short-circuit before standard error recovery (e.g. probe stops
    // once the candidate has shifted, collect-after stops once COMPLETE_HERE has been fed).
    if (policy.ShortCircuitOnError(*this)) goto yyabortlab;
    // If not already recovering from an error, count it.
    if (!yyerrstatus_) {
        ++yynerrs_;
    }
    yyerror_range[1].location = yyla.location;
    if (yyerrstatus_ == 3) {
        // If just tried and failed to reuse lookahead token after an error, discard it.
        // Return failure if at end of input.
        if (yyla.kind() == symbol_kind::S_YYEOF) {
            goto yyabortlab;
        } else if (!yyla.empty()) {
            yyla.clear();
        }
    }
    // Else will try to reuse lookahead token after shifting the error token.
    goto yyerrlab1;

yyerrlab1:
    yyerrstatus_ = 3;  // Each real token shifted decrements this.
    // Pop stack until we find a state that shifts the error token.
    for (;;) {
        yyn = yypact_[+yystack_[0].state];
        if (!yy_pact_value_is_default_(yyn)) {
            yyn += symbol_kind::S_YYerror;
            if (0 <= yyn && yyn <= yylast_ && yycheck_[yyn] == symbol_kind::S_YYerror) {
                yyn = yytable_[yyn];
                if (0 < yyn) break;
            }
        }
        // Pop the current state because it cannot handle the error token.
        if (yystack_.size() == 1) goto yyabortlab;
        yyerror_range[1].location = yystack_[0].location;
        yypop_();
    }
    {
        stack_symbol_type error_token;
        yyerror_range[2].location = yyla.location;
        YYLLOC_DEFAULT(error_token.location, yyerror_range, 2);
        // Shift the error token.
        yy_lac_discard_("error recovery");
        error_token.state = state_type(yyn);
        yypush_("Shifting", YY_MOVE(error_token));
    }
    goto yynewstate;

yyacceptlab:
    yyresult = 0;
    goto yyreturn;

yyabortlab:
    yyresult = 1;
    goto yyreturn;

yyreturn:
    if (!yyla.empty()) yyla.clear();
    // Do not reclaim the symbols of the rule whose action triggered this YYABORT or YYACCEPT.
    yypop_(yylen);
    while (1 < yystack_.size()) {
        yypop_();
    }
}

// Policy for ParseUntilAfter: at the cursor, replace the real token with the candidate
// `feed_symbol`. On the very next lookahead read, replace that one with COMPLETE_HERE so the
// parser errors at the post-feed state. The error handler then collects LAC-expected symbols.
struct CollectAfterPolicy {
    ChunkBufferEntryID target_symbol_id;
    Parser::symbol_kind_type feed_symbol;
    // 0 = parsing normally, 1 = fed the candidate, 2 = injected COMPLETE_HERE.
    int phase = 0;
    std::vector<Parser::ExpectedSymbol> expected_symbols;

    template <typename Iter>
    void OnLookaheadRead(Parser&, Parser::symbol_type& next_symbol, const Iter& pre_iter, uint32_t /*pre_token_index*/,
                         bool& /*stop*/) {
        if (phase == 1) {
            // Phase 1 → 2: inject COMPLETE_HERE so the next yyerrlab triggers LAC.
            auto marker = Parser::make_COMPLETE_HERE(next_symbol.location);
            next_symbol.move(marker);
            phase = 2;
            return;
        }
        if (phase == 0 && pre_iter >= target_symbol_id) {
            // Phase 0 → 1: replace the real cursor token with the candidate.
            auto fed = Parser::make_COMPLETE_HERE(next_symbol.location);
            fed.kind_ = feed_symbol;
            next_symbol.move(fed);
            phase = 1;
        }
    }
    void OnShifted(Parser&, Parser::symbol_kind_type) {}
    void OnAccept(Parser&) {}
    bool ShortCircuitOnError(Parser& p) {
        if (phase == 2) {
            expected_symbols = p.CollectExpectedSymbols();
            return true;
        }
        return false;
    }
};

std::vector<Parser::ExpectedSymbol> Parser::CollectExpectedSymbolsAfter(ChunkBufferEntryID target_symbol_id,
                                                                        symbol_kind_type feed_symbol) {
    CollectAfterPolicy policy{target_symbol_id, feed_symbol};
    DriveLALR(policy, /*init_stack=*/true);
    return std::move(policy.expected_symbols);
}

Parser::ExpectedAtCursor Parser::ParseUntilWithSnapshot(ScannedScript& scanned, ChunkBufferEntryID symbol_id) {
    ExpectedAtCursor out;
    ParseContext ctx{scanned};
    dashql::parser::Parser parser(ctx);
    parser.ParsePrefixToTarget(symbol_id, out.prefix);
    if (out.prefix.reached_target) {
        // Restore so yy_lac_check_ (which reads yystack_[].state) sees the captured state.
        parser.RestorePrefix(out.prefix);
        out.expected = parser.CollectExpectedSymbols();
    }
    return out;
}

std::vector<Parser::ExpectedSymbol> Parser::ParseUntilAfter(ScannedScript& scanned, ChunkBufferEntryID symbol_id,
                                                            symbol_kind_type feed_symbol) {
    ParseContext ctx{scanned};
    dashql::parser::Parser parser(ctx);
    return parser.CollectExpectedSymbolsAfter(symbol_id, feed_symbol);
}

std::vector<Parser::SuffixProbe> Parser::ProbeSuffixBatchFromSnapshot(ScannedScript& scanned,
                                                                      ChunkBufferEntryID symbol_id,
                                                                      const PrefixSnapshot& prefix,
                                                                      std::span<const symbol_kind_type> feed_symbols,
                                                                      bool replace_target) {
    std::vector<SuffixProbe> out;
    out.resize(feed_symbols.size());  // default-constructed entries when prefix didn't reach target
    if (feed_symbols.empty() || !prefix.reached_target) return out;

    // Each suffix replay needs a fresh ParseContext (token iterator + LAC state must reset).
    for (size_t i = 0; i < feed_symbols.size(); ++i) {
        ParseContext suffix_ctx{scanned};
        dashql::parser::Parser suffix_parser(suffix_ctx);
        out[i] = suffix_parser.ProbeSuffixFromPrefix(prefix, symbol_id, feed_symbols[i], replace_target);
    }
    return out;
}

Parser::SuffixProbe Parser::ProbeSuffixSequenceFromSnapshot(ScannedScript& scanned, ChunkBufferEntryID symbol_id,
                                                            const PrefixSnapshot& prefix,
                                                            std::span<const symbol_kind_type> feed_symbols,
                                                            bool replace_target) {
    if (feed_symbols.empty() || !prefix.reached_target) return SuffixProbe{};
    ParseContext suffix_ctx{scanned};
    dashql::parser::Parser suffix_parser(suffix_ctx);
    return suffix_parser.ProbeSuffixSequenceFromPrefix(prefix, symbol_id, feed_symbols, replace_target);
}

// Run the LALR driver up to the cursor and snapshot just the state stack. Implemented as a
// parallel copy of the bison driver (like CollectExpectedSymbolsAt/After) because merging the
// control flows would require restructuring the goto-based skeleton.
//
// On entry to the cursor (i.e. when the iterator first points there), we stop *before* reading
// the lookahead — the suffix replay reproduces that read from the snapshot.
// Policy for ParsePrefixToTarget: parse the prefix normally; when the next read would consume
// the cursor's token, snapshot the state stack and stop.
struct PrefixCapturePolicy {
    ChunkBufferEntryID target_symbol_id;
    Parser::PrefixSnapshot& out;

    template <typename Iter>
    void OnLookaheadRead(Parser& p, Parser::symbol_type& /*next_symbol*/, const Iter& pre_iter,
                         uint32_t /*pre_token_index*/, bool& stop) {
        if (pre_iter >= target_symbol_id) {
            out.reached_target = true;
            // Capture state numbers from bottom to top.
            for (auto i = p.GetStackSize(); i > 0; --i) {
                out.state_stack.push_back(p.GetStackState(i - 1));
            }
            stop = true;
        }
    }
    void OnShifted(Parser&, Parser::symbol_kind_type) {}
    void OnAccept(Parser&) {}
    bool ShortCircuitOnError(Parser&) { return false; }
};

void Parser::ParsePrefixToTarget(ChunkBufferEntryID target_symbol_id, PrefixSnapshot& out) {
    out.state_stack.clear();
    out.reached_target = false;
    PrefixCapturePolicy policy{target_symbol_id, out};
    DriveLALR(policy, /*init_stack=*/true);
}

// Restore a captured state stack into the parser. PrefixCapturePolicy stores states bottom-to-top,
// matching yystack_'s push order; GetStackState itself indexes from the top. We push only state
// numbers — semantic values are not needed by the no-op reductions or LAC checks.
void Parser::RestorePrefix(const PrefixSnapshot& prefix) {
    yystack_.clear();
    if (prefix.state_stack.empty()) return;
    for (auto state : prefix.state_stack) {
        stack_symbol_type stk;
        stk.state = state;
        yypush_(YY_NULLPTR, YY_MOVE(stk));
    }
    yy_lac_discard_("init");
}

// Replay the suffix from a captured prefix state stack: restores the parser state, advances the
// scanner iterator to the target token, then drives the shared LALR loop with `SuffixProbePolicy`.
//
// Policy for ProbeSuffixFromPrefix — the parser stack is already restored from the prefix
// snapshot before DriveLALR is called, and the scanner has been advanced to the target. The very
// first lookahead read is at the cursor — replace it with the feed symbol (and rewind the scanner
// for insert mode, so the real target is re-read afterward). Then count how many real post-cursor
// tokens shift cleanly before the parser errors or accepts.
struct SuffixProbePolicy {
    std::span<const Parser::symbol_kind_type> feed_symbols;
    bool replace_target;
    Parser::SuffixProbe probe;
    // Index of the next feed symbol to inject; == feed_symbols.size() once the whole sequence has
    // been fed. While < size we are still injecting synthetic tokens; the real suffix flows after.
    size_t fed_count = 0;
    // Number of feed symbols that have actually shifted onto the stack. Once this reaches
    // feed_symbols.size() the subsequent shifts are real post-cursor tokens.
    size_t feed_shifted = 0;

    template <typename Iter>
    void OnLookaheadRead(Parser& p, Parser::symbol_type& next_symbol, const Iter& pre_iter, uint32_t pre_token_index,
                         bool& /*stop*/) {
        if (fed_count < feed_symbols.size()) {
            auto fed = Parser::make_COMPLETE_HERE(next_symbol.location);
            fed.kind_ = feed_symbols[fed_count];
            // Rewind so the real token that was just read is re-read next. For replace mode we
            // still want the *first* fed symbol to stand in for the target (so we skip the target),
            // but every fed symbol after the first is an insertion and must not consume a real
            // token. In insert mode all fed symbols are insertions.
            bool consumes_target = replace_target && fed_count == 0;
            if (!consumes_target) {
                p.GetCtx().RewindScanner(pre_iter, pre_token_index);
            }
            next_symbol.move(fed);
            ++fed_count;
        }
        // Otherwise this is a real post-cursor token; the driver uses it as-is.
    }
    void OnShifted(Parser&, Parser::symbol_kind_type shifted_kind) {
        if (feed_shifted < feed_symbols.size()) {
            // A fed symbol shifted. Once all of them have shifted, real suffix tokens follow.
            ++feed_shifted;
            return;
        }
        // Real post-cursor tokens aligning with the grammar's expectation after the fed sequence.
        if (shifted_kind != Parser::symbol_kind_type::S_YYEOF) {
            if (probe.depth_consumed == 0) probe.k1_compatible = true;
            if (probe.depth_consumed < std::numeric_limits<uint16_t>::max()) ++probe.depth_consumed;
        }
    }
    void OnAccept(Parser&) {
        // Reaching the final state while replaying the suffix means the fed sequence + rest of the
        // post-cursor stream is a complete parse — the strongest signal we can give.
        probe.reached_eof = true;
    }
    bool ShortCircuitOnError(Parser&) {
        // Stop once a synthetic symbol has been offered. If it cannot shift, standard error
        // recovery would consume the entire real suffix for every candidate without providing
        // any additional compatibility signal.
        return fed_count >= 1;
    }
};

Parser::SuffixProbe Parser::ProbeSuffixFromPrefix(const PrefixSnapshot& prefix, ChunkBufferEntryID target_symbol_id,
                                                  symbol_kind_type feed_symbol, bool replace_target) {
    std::array<symbol_kind_type, 1> feed{feed_symbol};
    return ProbeSuffixSequenceFromPrefix(prefix, target_symbol_id, feed, replace_target);
}

Parser::SuffixProbe Parser::ProbeSuffixSequenceFromPrefix(const PrefixSnapshot& prefix,
                                                          ChunkBufferEntryID target_symbol_id,
                                                          std::span<const symbol_kind_type> feed_symbols,
                                                          bool replace_target) {
    if (!prefix.reached_target || feed_symbols.empty()) return SuffixProbe{};
    RestorePrefix(prefix);
    // Advance the scanner to the target token. Discard everything before it.
    while (!ctx.symbol_iterator.IsAtEnd() && ctx.symbol_iterator != target_symbol_id) {
        ctx.NextSymbol();
    }
    SuffixProbePolicy policy{feed_symbols, replace_target};
    DriveLALR(policy, /*init_stack=*/false);
    return policy.probe;
}

/// Obfuscated strings that are cast to a type need a replacement that the type accepts.
/// E.g. timestamptz /*String(A834)*/ cannot become timestamptz 'A834'.
static void ReplaceObfuscatedCastLiterals(ParsedScript& parsed) {
    auto& scanned = *parsed.scanned_script;
    if (scanned.obfuscated_literals.empty()) return;
    auto input = scanned.GetInput();
    for (auto& node : parsed.nodes) {
        if (node.node_type() != buffers::parser::NodeType::LITERAL_STRING ||
            node.attribute_key() != buffers::parser::AttributeKey::SQL_CONST_CAST_VALUE) {
            continue;
        }
        auto& cast = parsed.nodes[node.parent()];
        if (cast.node_type() != buffers::parser::NodeType::OBJECT_SQL_CONST_TYPE_CAST &&
            cast.node_type() != buffers::parser::NodeType::OBJECT_SQL_CONST_FUNCTION_CAST &&
            cast.node_type() != buffers::parser::NodeType::OBJECT_SQL_CONST_INTERVAL_CAST) {
            continue;
        }
        auto literal_span = scanned.ResolveTextSpan(node.symbol_span());
        auto* literal = scanned.FindObfuscatedLiteral(literal_span.offset());
        if (!literal) continue;
        // The type is the text of the cast in front of the literal, e.g. "timestamp with time zone"
        auto cast_span = scanned.ResolveTextSpan(cast.symbol_span());
        std::string type{input.substr(cast_span.offset(), literal_span.offset() - cast_span.offset())};
        std::transform(type.begin(), type.end(), type.begin(), [](unsigned char c) { return std::tolower(c); });
        auto hash = literal->replacement.substr(1, 4);
        auto has = [&](std::string_view s) { return type.find(s) != std::string::npos; };
        if (has("timestamp")) {
            literal->replacement = "'2000-01-01 00:00:00'";
        } else if (has("date")) {
            literal->replacement = "'2000-01-01'";
        } else if (has("time")) {
            literal->replacement = "'00:00:00'";
        } else if (has("interval")) {
            literal->replacement = "'1'";
        } else if (has("uuid")) {
            literal->replacement = "'00000000-0000-0000-0000-00000000" + hash + "'";
        } else if (has("json")) {
            literal->replacement = "'{}'";
        } else if (has("bool")) {
            literal->replacement = "'true'";
        } else if (has("int") || has("numeric") || has("decimal") || has("real") || has("double") || has("float")) {
            literal->replacement = "'" + std::to_string(std::stoul(hash, nullptr, 16)) + "'";
        }
    }
}

std::shared_ptr<ParsedScript> Parser::Parse(std::shared_ptr<ScannedScript> scanned, bool debug) {
    assert(scanned != nullptr);

#ifndef NDEBUG
    if (debug) {
        std::cout << "--- SYMBOLS ---" << std::endl;
        scanned->symbols.ForEach([&](size_t i, parser::Parser::symbol_type token) {
            std::cout << token.location.offset() << " " << Parser::symbol_name(token.kind()) << std::endl;
            assert(token.location.offset() < scanned->GetInput().size());
            assert(token.location.offset() + token.location.length() <= scanned->GetInput().size());
        });
        std::cout << "--- PARSER ---" << std::endl;
    }
#endif

    // Parse the tokens
    ParseContext ctx{*scanned};
    dashql::parser::Parser parser(ctx);
#ifndef NDEBUG
    parser.yydebug_ = debug;
#endif
    parser.parse();

    // We might leak nary expression to our temporary list during error recovery.
    // If there are no errors, the temporary nary expression list must be empty.
    if (ctx.errors.empty()) {
        // Make sure we didn't leak into our temp allocators.
        // This can happen quickly when not consuming an allocated list in a bison rule.
#define DEBUG_BISON_LEAKS 1
#if DEBUG_BISON_LEAKS
        ctx.temp_list_elements.ForEachAllocated([&](size_t value_id, NodeList::ListElement& elem) {
            std::cout << buffers::parser::EnumNameAttributeKey(
                             static_cast<buffers::parser::AttributeKey>(elem.node.attribute_key()))
                      << " " << buffers::parser::EnumNameNodeType(elem.node.node_type()) << " "
                      << scanned->GetInput().substr(elem.node.symbol_span().offset(), elem.node.symbol_span().length())
                      << "\n"
                      << std::flush;
        });
        assert(ctx.temp_nary_expressions.GetAllocatedNodeCount() == 0);
#endif
    }

    // Pack the program
    auto parsed = std::make_shared<ParsedScript>(scanned, std::move(ctx));
    ReplaceObfuscatedCastLiterals(*parsed);
    return parsed;
}

}  // namespace dashql::parser
