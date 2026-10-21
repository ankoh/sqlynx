// The grammar of DashQL, assembled by grammar/assemble_grammar.py.
// Emitted through //grammar/rust:tables.rs.m4, the actions run in dashql_grammar::parser.

%code use {
use crate::parser::actions::*;
}

%define api.token.raw true
%define api.rust.context {ParseContext}
%define api.rust.location {SymbolSpan}
%define api.rust.error {ReduceError}

%require "3.3"

// ---------------------------------------------------------------------------
// TOKENS

/*
 * Non-keyword token types.  These are hard-wired into the scanner.
 * They must be listed first so that their numeric codes do not depend on
 * the set of keywords.  PL/pgSQL depends on this so that it can share the
 * same lexer.  If you add/change tokens here, fix PL/pgSQL to match!
 */

%token<NameId> IDENT   "identifier literal"
%token         SCONST  "string literal"
%token         Op
%token         FCONST BCONST XCONST
%token         ICONST PARAM
%token         TYPECAST DOT DOT_DOT DOT_TRAILING COLON_EQUALS EQUALS_GREATER
%token         LESS_EQUALS GREATER_EQUALS NOT_EQUALS
%token         COMPLETE_HERE

%token         LRB RRB LSB RSB LCB RCB STAR COMMA COLON QUESTION_MARK DOLLAR SEMICOLON
%token         MINUS PLUS DIVIDE MODULO
%token         LESS_THAN GREATER_THAN EQUALS
%token         CIRCUMFLEX AMPERSAND PIPE EXCLAMATION_MARK
%token         RAW_CHAR

%token EOF 0

%token<Str> VISUALIZE_LA

/*
 * The grammar thinks these are keywords, but they are not in the kwlist.h
 * list and so can never be entered directly.  The filter in parser.c
 * creates these tokens when required (based on looking one token ahead).
 *
 * NOT_LA exists so that productions such as NOT LIKE can be given the same
 * precedence as LIKE; otherwise they'd effectively have the same precedence
 * as NOT, at least with respect to their left-hand subexpression.
 * NULLS_LA, WITH_LA, and DOT_STAR_LA are needed to make the grammar LALR(1).
 */
%token        NOT_LA NULLS_LA WITH_LA DOT_STAR_LA
