%skeleton "lalr1.cc"
%require "3.3"

%define api.namespace {dashql::parser}
%define api.parser.class {ParserBase}
%define api.token.constructor
%define api.token.prefix {FQL_}
%define api.value.type variant
%define api.token.raw true
%define parse.error verbose
%define parse.lac full

%locations
%define api.location.type {buffers::Location}

%parse-param    { dashql::parser::ParseContext& ctx }

// ---------------------------------------------------------------------------
// HEADER

%code requires {

#ifndef NDEBUG
#define YYDEBUG 1
#endif

#include <string>
#include <cstdlib>
#include <utility>
#include "dashql/parser/grammar/state.h"
#include "dashql/parser/grammar/location.h"
#include "dashql/buffers/index_generated.h"

namespace sx = dashql::buffers;

namespace dashql { namespace parser { class ParseContext;  }}

#define YYRHSLOC(Rhs, K) ((Rhs)[K].location)
#define YYLLOC_DEFAULT(Cur, Rhs, N) { \
    if (N) { \
        uint32_t o = YYRHSLOC(Rhs, 1).offset(); \
        uint32_t l = YYRHSLOC(Rhs, N).offset() + YYRHSLOC(Rhs, N).length() - YYRHSLOC(Rhs, 1).offset(); \
        (Cur) = buffers::Location(o, l); \
    } else { \
        uint32_t o = YYRHSLOC(Rhs, 0).offset() + YYRHSLOC(Rhs, 0).length(); \
        uint32_t l = 0; \
        (Cur) = buffers::Location(o, l); \
    } \
}

}

// ---------------------------------------------------------------------------
// IMPLEMENTATION

%code {
#include "dashql/parser/grammar/enums.h"
#include "dashql/parser/grammar/location.h"
#include "dashql/parser/grammar/nodes.h"
#include "dashql/parser/scanner.h"
#include "dashql/parser/parse_context.h"

#undef yylex
#define yylex ctx.NextSymbol

using namespace dashql::parser;
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
%token         TYPECAST DOT DOT_DOT DOT_TRAILING COLON_EQUALS EQUALS_GREATER
%token         LESS_EQUALS GREATER_EQUALS NOT_EQUALS
%token         COMPLETE_HERE

%token         LRB RRB LSB RSB STAR COMMA COLON QUESTION_MARK DOLLAR SEMICOLON
%token         MINUS PLUS DIVIDE MODULO
%token         LESS_THAN GREATER_THAN EQUALS
%token         CIRCUMFLEX
%token         RAW_CHAR

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
