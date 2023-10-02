#include "flatsql/parser/parser.h"

#include "flatsql/parser/parse_context.h"
#include "flatsql/parser/parser_generated.h"

namespace flatsql::parser {

void flatsql::parser::ParserBase::error(const location_type& loc, const std::string& message) {
    ctx.AddError(loc, message);
}

/// Collect all expected symbols
std::vector<Parser::symbol_kind_type> Parser::CollectExpectedSymbols() {
    std::vector<symbol_kind_type> expected;

    // Actual number of expected tokens
    const int yyn = yypact_[+yystack_[0].state];
    if (!yy_pact_value_is_default_(yyn)) {
        /* Start YYX at -YYN if negative to avoid negative indexes in
            YYCHECK.  In other words, skip the first -YYN actions for
            this state because they are default actions.  */
        const int yyxbegin = yyn < 0 ? -yyn : 0;
        // Stay within bounds of both yycheck and yytname.
        const int yychecklim = yylast_ - yyn + 1;
        const int yyxend = yychecklim < YYNTOKENS ? yychecklim : YYNTOKENS;
        for (int yyx = yyxbegin; yyx < yyxend; ++yyx) {
            if (yycheck_[yyx + yyn] == yyx && yyx != symbol_kind::S_YYerror &&
                !yy_table_value_is_error_(yytable_[yyx + yyn])) {
                expected.push_back(YY_CAST(symbol_kind_type, yyx));
            }
        }
    }
    return expected;
}

#define DEBUG_COMPLETE_AT 0
std::vector<Parser::symbol_kind_type> Parser::CollectExpectedSymbolsAt(size_t target_symbol_id) {
    // Helper to print a symbol
    auto yy_print = [this](const auto& yysym) {
#if DEBUG_COMPLETE_AT == 1
        if (yysym.empty()) {
            std::cout << "empty symbol";
        } else {
            symbol_kind_type yykind = yysym.kind();
            std::cout << (yykind < YYNTOKENS ? "token" : "nterm") << ' ' << yysym.name() << " ("
                      << yysym.location.offset() << ": " << yysym.location.length() << ')';
        }
#endif
    };
    // Helper to print a symbol with a prefix
    auto yy_symbol_print = [this, &yy_print](std::string_view prefix, const auto& sym) {
#if DEBUG_COMPLETE_AT == 1
        std::cout << prefix << " ";
        yy_print(sym);
        std::cout << std::endl;
#endif
    };
    // Helper to print a reduction
    auto yy_reduce_print = [this, &yy_print](int yyrule) {
#if DEBUG_COMPLETE_AT == 1
        int yynrhs = yyr2_[yyrule];
        // Print the symbols being reduced, and their result.
        std::cout << "Reducing stack by rule " << yyrule - 1 << ":\n";
        // The symbols being reduced.
        for (int yyi = 0; yyi < yynrhs; yyi++) {
            std::cout << "   $" << yyi + 1 << " = ";
            yy_print(yystack_[(yynrhs) - (yyi + 1)]);
            std::cout << std::endl;
        }
#endif
    };

    // The expected symbols
    std::vector<Parser::symbol_kind_type> expected_symbols;
    // The current symbol index
    size_t current_symbol_id = 0;
    // The next symbol id
    int yyn;
    // The length of the RHS of the rule being reduced
    int yylen = 0;
    // The error count
    int yynerrs_ = 0;
    // The error status
    int yyerrstatus_ = 0;
    /// The lookahead symbol
    symbol_type yyla;
    /// The locations where the error started and ended
    stack_symbol_type yyerror_range[3];
    /// The return value of parse ()
    int yyresult;

    // Initialize the stack. The initial state will be set in
    // yynewstate, since the latter expects the semantical and the
    // location values to have been already stored, initialize these
    // stacks with a primary value.
    yystack_.clear();
    yypush_(YY_NULLPTR, 0, YY_MOVE(yyla));

yynewstate:
    // Accept?
    if (yystack_[0].state == yyfinal_) goto yyacceptlab;
    goto yybackup;

yybackup:
    // Try to take a decision without lookahead.
    yyn = yypact_[+yystack_[0].state];
    if (yy_pact_value_is_default_(yyn)) goto yydefault;

    // Read a lookahead token.
    if (yyla.empty()) {
        // Get the next symbol
        auto next_symbol = ctx.NextSymbol();
        // Did we reach the target index?
        if (current_symbol_id++ == target_symbol_id) {
            // Lookup the expected symbols if we would replace the target token
            expected_symbols = CollectExpectedSymbols();
            goto yyreturn;
        }
        // Store symbol as lookahead
        symbol_type yylookahead(std::move(next_symbol));
        yyla.move(yylookahead);
    }

    if (yyla.kind() == symbol_kind::S_YYerror) {
        // The scanner already issued an error message, process directly
        // to error recovery.  But do not keep the error token as
        // lookahead, it is too special and may lead us to an endless
        // loop in error recovery.
        yyla.kind_ = symbol_kind::S_YYUNDEF;
        goto yyerrlab1;
    }

    // If the proper action on seeing token YYLA.TYPE is to reduce or
    // to detect an error, take that action.
    yyn += yyla.kind();
    if (yyn < 0 || yylast_ < yyn || yycheck_[yyn] != yyla.kind()) {
        goto yydefault;
    }

    // Reduce or error.
    yyn = yytable_[yyn];
    if (yyn <= 0) {
        if (yy_table_value_is_error_(yyn)) goto yyerrlab;
        yyn = -yyn;
        goto yyreduce;
    }

    // Count tokens shifted since error; after three, turn off error status.
    if (yyerrstatus_) --yyerrstatus_;

    // Shift the lookahead token.
    yypush_("Shifting", state_type(yyn), YY_MOVE(yyla));
    goto yynewstate;

yydefault:
    yyn = yydefact_[+yystack_[0].state];
    if (yyn == 0) goto yyerrlab;
    goto yyreduce;

yyreduce:
    yylen = yyr2_[yyn];
    {
        stack_symbol_type yylhs;
        yylhs.state = yy_lr_goto_state_(yystack_[yylen].state, yyr1_[yyn]);

        // Variants are always initialized to an empty instance of the
        // correct type. The default '$$ = $1' action is NOT applied
        // when using variants
        switch (yyr1_[yyn]) {
                // ....
                // Initialize yylhs.value
            default:
                break;
        }

        // Default location.
        {
            stack_type::slice range(yystack_, yylen);
            YYLLOC_DEFAULT(yylhs.location, range, yylen);
            yyerror_range[1].location = yylhs.location;
        }

        // Perform the reduction.
        yy_reduce_print(yyn);
        // Reductions
        {
            switch (yyn) {
                default:
                    break;
            }
        }

        yy_symbol_print("-> $$ =", yylhs);
        yypop_(yylen);
        yylen = 0;

        // Shift the result of the reduction.
        yypush_(YY_NULLPTR, YY_MOVE(yylhs));
    }
    goto yynewstate;

yyerrlab:
    // If not already recovering from an error, report this error.
    if (!yyerrstatus_) {
        ++yynerrs_;
        context yyctx(*this, yyla);
        std::string msg = yysyntax_error_(yyctx);
        error(yyla.location, YY_MOVE(msg));
    }

    yyerror_range[1].location = yyla.location;
    if (yyerrstatus_ == 3) {
        /* If just tried and failed to reuse lookahead token after an
           error, discard it.  */

        // Return failure if at end of input.
        if (yyla.kind() == symbol_kind::S_YYEOF) {
            goto yyabortlab;
        } else if (!yyla.empty()) {
            yy_destroy_("Error: discarding", yyla);
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
        yy_destroy_("Error: popping", yystack_[0]);
        yypop_();
        // YY_STACK_PRINT();
    }
    {
        stack_symbol_type error_token;

        yyerror_range[2].location = yyla.location;
        YYLLOC_DEFAULT(error_token.location, yyerror_range, 2);

        // Shift the error token.
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
    if (!yyla.empty()) yy_destroy_("Cleanup: discarding lookahead", yyla);

    // Do not reclaim the symbols of the rule whose action triggered
    // this YYABORT or YYACCEPT.
    yypop_(yylen);
    // YY_STACK_PRINT();
    while (1 < yystack_.size()) {
        yy_destroy_("Cleanup: popping", yystack_[0]);
        yypop_();
    }
    return expected_symbols;
}

std::vector<Parser::symbol_kind_type> Parser::ParseUntil(ScannedScript& scanned, size_t symbol_id) {
    ParseContext ctx{scanned};
    flatsql::parser::Parser parser(ctx);
    auto expected = parser.CollectExpectedSymbolsAt(symbol_id);
    return expected;
}

std::pair<std::shared_ptr<ParsedScript>, proto::StatusCode> Parser::Parse(std::shared_ptr<ScannedScript> scanned,
                                                                          bool trace_scanning, bool trace_parsing) {
    if (scanned == nullptr) {
        return {nullptr, proto::StatusCode::PARSER_INPUT_INVALID};
    }

    // Parse the tokens
    ParseContext ctx{*scanned};
    flatsql::parser::Parser parser(ctx);
    parser.parse();

    // Make sure we didn't leak into our temp allocators.
    // This can happen quickly when not consuming an allocated list in a bison rule.
#define DEBUG_BISON_LEAKS 0
#if DEBUG_BISON_LEAKS
    auto text = in.ToString();
    auto text_view = std::string_view{text};
    ctx.temp_list_elements.ForEachAllocated([&](size_t value_id, NodeList::ListElement& elem) {
        std::cout << proto::EnumNameAttributeKey(static_cast<proto::AttributeKey>(elem.node.attribute_key())) << " "
                  << proto::EnumNameNodeType(elem.node.node_type()) << " "
                  << text_view.substr(elem.node.location().offset(), elem.node.location().length()) << std::endl;
    });
#else
    if (ctx.errors.empty()) {
        assert(ctx.temp_list_elements.GetAllocatedNodeCount() == 0);
    }
#endif

    assert(ctx.temp_nary_expressions.GetAllocatedNodeCount() == 0);

    // Pack the program
    return {std::make_shared<ParsedScript>(scanned, std::move(ctx)), proto::StatusCode::OK};
}

}  // namespace flatsql::parser
