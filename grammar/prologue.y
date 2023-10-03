%skeleton "lalr1.cc"
%require "3.3"

%define api.namespace {flatsql::parser}
%define api.parser.class {ParserBase}
%define api.token.constructor
%define api.token.prefix {FQL_}
%define api.value.type variant
%define parse.error verbose

%locations
%define api.location.type {proto::Location}

%parse-param    { flatsql::parser::ParseContext& ctx }

// ---------------------------------------------------------------------------
// HEADER

%code requires {
#include <string>
#include <cstdlib>
#include <utility>
#include "flatsql/parser/grammar/state.h"
#include "flatsql/proto/proto_generated.h"

namespace sx = flatsql::proto;

namespace flatsql { namespace parser { class ParseContext;  }}

#define YYRHSLOC(Rhs, K) ((Rhs)[K].location)
#define YYLLOC_DEFAULT(Cur, Rhs, N) { \
    if (N) { \
        uint32_t o = YYRHSLOC(Rhs, 1).offset(); \
        uint32_t l = YYRHSLOC(Rhs, N).offset() + YYRHSLOC(Rhs, N).length() - YYRHSLOC(Rhs, 1).offset(); \
        (Cur) = proto::Location(o, l); \
    } else { \
        uint32_t o = YYRHSLOC(Rhs, 0).offset() + YYRHSLOC(Rhs, 0).length(); \
        uint32_t l = 0; \
        (Cur) = proto::Location(o, l); \
    } \
}
}

// ---------------------------------------------------------------------------
// IMPLEMENTATION

%code {
#include "flatsql/parser/grammar/enums.h"
#include "flatsql/parser/grammar/location.h"
#include "flatsql/parser/grammar/nodes.h"
#include "flatsql/parser/scanner.h"
#include "flatsql/parser/parse_context.h"

#undef yylex
#define yylex ctx.NextSymbol

using namespace flatsql::parser;
}

// ---------------------------------------------------------------------------
// TOKENS

/*
 * Non-keyword token types.  These are hard-wired into the "flex" lexer.
 * They must be listed first so that their numeric codes do not depend on
 * the set of keywords.  PL/pgSQL depends on this so that it can share the
 * same lexer.  If you add/change tokens here, fix PL/pgSQL to match!
 */

%token<size_t> IDENT   "identifier literal"
%token         SCONST  "string literal"
%token         Op
%token         FCONST BCONST XCONST
%token         ICONST PARAM
%token         TYPECAST DOT DOT_DOT COLON_EQUALS EQUALS_GREATER
%token         LESS_EQUALS GREATER_EQUALS NOT_EQUALS
%token         COMPLETE_HERE

%token EOF 0

/*
 * The grammar thinks these are keywords, but they are not in the kwlist.h
 * list and so can never be entered directly.  The filter in parser.c
 * creates these tokens when required (based on looking one token ahead).
 *
 * NOT_LA exists so that productions such as NOT LIKE can be given the same
 * precedence as LIKE; otherwise they'd effectively have the same precedence
 * as NOT, at least with respect to their left-hand subexpression.
 * NULLS_LA and WITH_LA are needed to make the grammar LALR(1).
 */
%token        NOT_LA NULLS_LA WITH_LA
