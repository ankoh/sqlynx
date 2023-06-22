%{
// Header
#include <cerrno>
#include <climits>
#include <cstdlib>
#include <sstream>
#include <string_view>
#include <string>
#include <charconv>
#include "flatsql/parser/grammar/keywords.h"
#include "flatsql/parser/grammar/location.h"
#include "flatsql/parser/parser_generated.h"
#include "flatsql/parser/scanner.h"

// ISO C++17 does not allow 'register' storage class specifier
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wregister"
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wregister"

using namespace flatsql;
using namespace flatsql::parser;
namespace sx = proto;

// Flex use 16KiB buffers by default.
// This is way too large as the data comes from main-memory anyway.
#undef YY_BUF_SIZE
#define YY_BUF_SIZE 1024
#define YY_STATE_BUF_SIZE   ((YY_BUF_SIZE + 2) * sizeof(yy_state_type))

// Declare the yylex function
#define YY_DECL Parser::symbol_type yylex(void* yyscanner)
// Declare yy_extra_type
#define YY_EXTRA_TYPE flatsql::parser::Scanner*

// Define the function to fill data into the buffer.
// `bytes_read` is for compatibility since flex generates int and size_t
#define YY_INPUT(buf,result,max_size) { \
    static_assert(YY_NULL == 0, "unexpected YY_NULL value"); \
    size_t bytes_read = 0; \
    flatsql_yyget_extra(yyscanner)->ScanNextInputData(buf,bytes_read,max_size); \
    result = static_cast<decltype(result)>(bytes_read); \
}

// The user action is run whenever a token is matched.
// We update the token location and register line breaks.
#define YY_USER_ACTION { \
    yytext_view = std::string_view{yytext, static_cast<size_t>(yyleng)}; \
    loc = sx::Location(ctx.current_input_offset, yyleng); \
    ctx.current_input_offset += yyleng; \
    for (unsigned i = 0; i < yyleng; ++i) { \
        if (yytext[i] == '\n') { \
            ctx.AddLineBreak(sx::Location(loc.offset() + i, 1)); \
        } \
    } \
}

// Return EOF token in yyterminate
#define yyterminate() return Parser::make_EOF(loc)

using YYLTYPE = sx::Location;
using YYSTYPE = flatsql::parser::Parser::symbol_type;

%}

%{
// Options
%}
%{
// noyywrap:    Disable yywrap (EOF == end of parsing)
// nounput:     Disable manipulation of input stream
// noinput:     Disable explicit fetch of the next character
// batch:       Scanner in batch-mode (vs. interactive)
// caseless:    Case-insensitive pattern matching
%}
%option reentrant
%option nodefault
%option noinput
%option nounput
%option noyywrap
%option never-interactive
%option batch
%option caseless
%option prefix="flatsql_yy"

/*
 * OK, here is a short description of lex/flex rules behavior.
 * The longest pattern which matches an input string is always chosen.
 * For equal-length patterns, the first occurring in the rules list is chosen.
 * INITIAL is the starting state, to which all non-conditional rules apply.
 * Exclusive states change parsing rules while the state is active.  When in
 * an exclusive state, only those rules defined for that state apply.
 *
 * Exclusive states:
 *  <xb> bit string literal
 *  <xc> extended C-style comments
 *  <xd> delimited identifiers (double-quoted identifiers)
 *  <xh> hexadecimal numeric string
 *  <xq> standard quoted strings
 *
 * Remember to add an <<EOF>> case whenever you add a new exclusive state!
 * The default one is probably not the right thing.
 */

%x xb
%x xc
%x xd
%x xh
%x xq

/*
 * In order to make the world safe for Windows and Mac clients as well as
 * Unix ones, we accept either \n or \r as a newline.  A DOS-style \r\n
 * sequence will be seen as two successive newlines, but that doesn't cause '
 * any problems.  Comments that start with -- and extend to the next
 * newline are treated as equivalent to a single whitespace character.
 *
 * NOTE a fine point: if there is no newline following --, we will absorb
 * everything to the end of the input as a comment.  This is correct.  Older
 * versions of Postgres failed to recognize -- as a comment if the input
 * did not end with a newline.
 *
 * XXX perhaps \f (formfeed) should be treated as a newline as well?
 *
 * XXX if you change the set of whitespace characters, fix scanner_isspace()
 * to agree, and see also the plpgsql lexer.
 */

space           [ \t\n\r\f]
horiz_space     [ \t\f]
newline         [\n\r]
non_newline     [^\n\r]

comment         ("--"{non_newline}*)

whitespace      ({space}+|{comment})

/*
 * SQL requires at least one newline in the whitespace separating
 * string literals that are to be concatenated.  Silly, but who are we
 * to argue?  Note that {whitespace_with_newline} should not have * after
 * it, whereas {whitespace} should generally have a * after it...
 */

special_whitespace      ({space}+|{comment}{newline})
horiz_whitespace        ({horiz_space}|{comment})
whitespace_with_newline ({horiz_whitespace}*{newline}{special_whitespace}*)

/*
 * To ensure that {quotecontinue} can be scanned without having to back up
 * if the full pattern isn't matched, we include trailing whitespace in
 * {quotestop}.  This matches all cases where {quotecontinue} fails to match,
 * except for {quote} followed by whitespace and just one "-" (not two,
 * which would start a {comment}).  To cover that we have {quotefail}.
 * The actions for {quotestop} and {quotefail} must throw back characters
 * beyond the quote proper.
 */

quote           '
quotestop       {quote}{whitespace}*
quotecontinue   {quote}{whitespace_with_newline}{quote}
quotefail       {quote}{whitespace}*"-"

/* Bit string
 * It is tempting to scan the string for only those characters
 * which are allowed. However, this leads to silently swallowed
 * characters if illegal characters are included in the string.
 * For example, if xbinside is [01] then B'ABCD' is interpreted
 * as a zero-length string, and the ABCD' is lost!
 * Better to pass the string forward and let the input routines
 * validate the contents.
 */

xbstart         [bB]{quote}
xbinside        [^']*

/* Hexadecimal number */
xhstart         [xX]{quote}
xhinside        [^']*

/* Extended quote
 * xqdouble implements embedded quote, ''''
 */
xqstart         {quote}
xqdouble        {quote}{quote}
xqinside        [^']+

/* Double quote
 * Allows embedded spaces and other special characters into identifiers.
 */
dquote          \"
xdstart         {dquote}
xdstop          {dquote}
xddouble        {dquote}{dquote}
xdinside        [^"]+

/* C-style comments
 *
 * The "extended comment" syntax closely resembles allowable operator syntax.
 * The tricky part here is to get lex to recognize a string starting with
 * slash-star as a comment, when interpreting it as an operator would produce
 * a longer match --- remember lex will prefer a longer match!  Also, if we
 * have something like plus-slash-star, lex will think this is a 3-character
 * operator whereas we want to see it as a + operator and a comment start.
 * The solution is two-fold:
 * 1. append {op_chars}* to xcstart so that it matches as much text as
 *    {operator} would. Then the tie-breaker (first matching rule of same
 *    length) ensures xcstart wins.  We put back the extra stuff with yyless()
 *    in case it contains a star-slash that should terminate the comment.
 * 2. In the operator rule, check for slash-star within the operator, and
 *    if found throw it back with yyless().  This handles the plus-slash-star
 *    problem.
 * Dash-dash comments have similar interactions with the operator rule.
 */
xcstart         \/\*{op_chars}*
xcstop          \*+\/
xcinside        [^*/]+

digit           [0-9]
ident_start     [A-Za-z\200-\377_]
ident_cont      [A-Za-z\200-\377_0-9\$]

identifier      {ident_start}{ident_cont}*

/* Assorted special-case operators and operator-like tokens */
typecast        "::"
dot_dot         \.\.
colon_equals    ":="

/*
 * These operator-like tokens (unlike the above ones) also match the {operator}
 * rule, which means that they might be overridden by a longer match if they
 * are followed by a comment start or a + or - character. Accordingly, if you
 * add to this list, you must also add corresponding code to the {operator}
 * block to return the correct token in such cases. (This is not needed in
 * psqlscan.l since the token value is ignored there.)
 */
equals_greater  "=>"
less_equals     "<="
greater_equals  ">="
less_greater    "<>"
not_equals      "!="

/*
 * "self" is the set of chars that should be returned as single-character
 * tokens.  "op_chars" is the set of chars that can make up "Op" tokens,
 * which can be one or more characters long (but if a single-char token
 * appears in the "self" set, it is not to be returned as an Op).  Note
 * that the sets overlap, but each has some chars that are not in the other.
 *
 * If you change either set, adjust the character lists appearing in the
 * rule for "operator"!
 */
self            [,()\[\].;\:\+\-\*\/\%\^\<\>\=]
op_chars        [\~\!\@\#\^\&\|\`\+\-\*\/\%\<\>\=]
operator        {op_chars}+

/* we no longer allow unary minus in numbers.
 * instead we pass it separately to parser. there it gets
 * coerced via doNegate() -- Leon aug 20 1999
 *
 * {decimalfail} is used because we would like "1..10" to lex as 1, dot_dot, 10.
 *
 * {realfail1} and {realfail2} are added to prevent the need for scanner
 * backup when the {real} rule fails to match completely.
 */
integer         {digit}+
decimal         (({digit}*\.{digit}+)|({digit}+\.{digit}*))
decimalfail     {digit}+\.\.
real            ({integer}|{decimal})[Ee][-+]?{digit}+
realfail1       ({integer}|{decimal})[Ee]
realfail2       ({integer}|{decimal})[Ee][-+]

param           \${integer}
param2          \?{integer}

other           .

/*
 * Dollar quoted strings are totally opaque, and no escaping is done on them.
 * Other quoted strings must allow some special characters such as single-quote
 *  and newline.
 * Embedded single-quotes are implemented both in the SQL standard
 *  style of two adjacent single quotes "''" and in the Postgres/Java style
 *  of escaped-quote "\'".
 * Other embedded escaped characters are matched explicitly and the leading
 *  backslash is dropped from the string.
 * Note that xcstart must appear before operator, as explained above!
 *  Also whitespace (comment) must appear before operator.
 */

%%

%{
// This code is inlined at the beginning of yylex()

Scanner& ctx = *flatsql_yyget_extra(yyscanner);

sx::Location loc;
std::string_view yytext_view;
auto& ext_begin = ctx.ext_begin;
auto& temp_buffer = ctx.temp_buffer;
auto& ext_depth = ctx.ext_depth;

%}

{space}+        {}
{comment}       { ctx.AddComment(loc); } 

{xcstart}       { temp_buffer = yytext_view; ext_begin = loc; ++ext_depth; BEGIN(xc); }
<xc>{xcstart}   { temp_buffer += yytext_view; ext_begin = loc; ++ext_depth; }
<xc>{xcstop}    {
                    temp_buffer += yytext_view; 
                    if (--ext_depth == 0) { ctx.AddComment(Loc({ext_begin, loc})); BEGIN(INITIAL); }
                }
<xc>{xcinside}  { temp_buffer += yytext_view; }
<xc>{op_chars}  { temp_buffer += yytext_view; }
<xc>\*+         { temp_buffer += yytext_view; }
<xc><<EOF>>     { ctx.AddError(Loc({ext_begin, loc}), "unterminated comment"); BEGIN(INITIAL); }


{xbstart}       { temp_buffer = yytext_view; ext_begin = loc; BEGIN(xb); }
<xb>{quotestop} |
<xb>{quotefail} { temp_buffer += yytext_view; BEGIN(INITIAL); return ctx.ReadBitStringLiteral(temp_buffer, Loc({ext_begin, loc})); }
<xh>{xhinside}  |
<xb>{xbinside}  { temp_buffer += yytext_view; }
<xh>{quotecontinue} |
<xb>{quotecontinue} { temp_buffer += yytext_view; }
<xb><<EOF>>     { ctx.AddError(Loc({ext_begin, loc}), "unterminated bit string literal"); BEGIN(INITIAL); }
{xhstart}       { temp_buffer += yytext_view; ext_begin = loc; BEGIN(xh); }
<xh>{quotestop} |
<xh>{quotefail} { temp_buffer += yytext_view; BEGIN(INITIAL); return ctx.ReadHexStringLiteral(temp_buffer, Loc({ext_begin, loc})); }
<xh><<EOF>>     { ctx.AddError(Loc({ext_begin, loc}), "unterminated hexadecimal bit string literal"); BEGIN(INITIAL); }


{xqstart}       { temp_buffer = yytext_view; ext_begin = loc; BEGIN(xq); }
<xq>{quotestop} |
<xq>{quotefail} { temp_buffer += yytext_view; BEGIN(INITIAL); return ctx.ReadStringLiteral(temp_buffer, Loc({ext_begin, loc})); }
<xq>{xqdouble}  { temp_buffer += yytext_view; }
<xq>{xqinside}  { temp_buffer += yytext_view; }
<xq><<EOF>>     { ctx.AddError(Loc({ext_begin, loc}), "unterminated quoted string"); BEGIN(INITIAL); }


{xdstart}       { temp_buffer = yytext_view; ext_begin = loc; BEGIN(xd); }
<xd>{xddouble}  { temp_buffer += yytext_view; }
<xd>{xdinside}  { temp_buffer += yytext_view; }
<xd>{xdstop}    { 
                    temp_buffer += yytext_view;
                    auto xdloc = Loc({ ext_begin, loc });
                    if (xdloc.length() == 2) { ctx.AddError(xdloc, "zero-length delimited identifier"); }
                    BEGIN(INITIAL); 
                    return ctx.ReadDoubleQuotedIdentifier(temp_buffer, Loc({ext_begin, loc}));
                }
<xd><<EOF>>     { ctx.AddError(Loc({ ext_begin, loc }), "unterminated delimited identifier"); BEGIN(INITIAL); }

{typecast}          { return Parser::make_TYPECAST(loc); }
{dot_dot}           { return Parser::make_DOT_DOT(loc); }
{colon_equals}      { return Parser::make_COLON_EQUALS(loc); }
{equals_greater}    { return Parser::make_EQUALS_GREATER(loc); }
{less_equals}       { return Parser::make_LESS_EQUALS(loc); }
{greater_equals}    { return Parser::make_GREATER_EQUALS(loc); }
{less_greater}      { return Parser::make_NOT_EQUALS(loc); }
{not_equals}        { return Parser::make_NOT_EQUALS(loc); }
{self}              { return Parser::symbol_type(yytext[0], loc); }

{operator}      {
                    /*
                     * Check for embedded slash-star or dash-dash; those
                     * are comment starts, so operator must stop there.
                     * Note that slash-star or dash-dash at the first
                     * character will match a prior rule, not this one.
                     */
                    int nchars = yyleng;
                    char* slashstar = strstr(yytext, "/*"); /* slash star */
                    char* dashdash = strstr(yytext, "--");

                    if (slashstar && dashdash) {
                        /* if both appear, take the first one */
                        if (slashstar > dashdash)
                            slashstar = dashdash;
                    } else if (!slashstar) {
                        slashstar = dashdash;
                    }
                    if (slashstar) {
                        nchars = slashstar - yytext;
                    }

                    /*
                     * For SQL compatibility, '+' and '-' cannot be the
                     * last char of a multi-char operator unless the operator
                     * contains chars that are not in SQL operators.
                     * The idea is to lex '=-' as two operators, but not
                     * to forbid operator names like '?-' that could not be
                     * sequences of SQL operators.
                     */
                    while (nchars > 1 && (yytext[nchars - 1] == '+' || yytext[nchars - 1] == '-')) {
                        int ic;
                        for (ic = nchars - 2; ic >= 0; ic--) {
                            if (strchr("~!@#^&|`?%", yytext[ic]))
                                break;
                        }
                        if (ic >= 0)
                            break; /* found a char that makes it OK */
                        nchars--; /* else remove the +/-, and check again */
                    }

                    /* We don't accept leading ? in any multi-character operators
                    * except for those in use by hstore, JSON and geometric operators.
                    *
                    * We don't accept contained or trailing ? in any
                    * multi-character operators.
                    *
                    * This is necessary in order to support normalized queries without
                    * spacing between ? as a substition character and a simple operator (e.g. "?=?")
                    */
                    if (yytext[0] == '?' &&
                        strcmp(yytext, "?|") != 0 && strcmp(yytext, "?&") != 0 &&
                        strcmp(yytext, "?#") != 0 && strcmp(yytext, "?-") != 0 &&
                        strcmp(yytext, "?-|") != 0 && strcmp(yytext, "?||") != 0) {
                        nchars = 1;
                    }

                    if (yytext[0] != '?' && strchr(yytext, '?')) {
                        /* Lex up to just before the ? character */
                        nchars = strchr(yytext, '?') - yytext;
                    }

                    if ((yy_size_t) nchars < yyleng) {
                        /* Strip the unwanted chars from the token */
                        yyless(yyleng - nchars);
                        /*
                         * If what we have left is only one char, and it's
                         * one of the characters matching "self", then
                         * return it as a character token the same way
                         * that the "self" rule would have.
                         */
                        if (nchars == 1 &&
                            strchr(",()[].;:+-*/%^<>=?", yytext[0])) {
                            return Parser::symbol_type(yytext[0], loc);
                        }
                        /*
                         * Likewise, if what we have left is two chars, and
                         * those match the tokens ">=", "<=", "=>", "<>" or
                         * "!=", then we must return the appropriate token
                         * rather than the generic Op.
                         */
                        if (nchars == 2) {
                            if (yytext[0] == '=' && yytext[1] == '>')
                                return Parser::make_EQUALS_GREATER(loc);
                            if (yytext[0] == '>' && yytext[1] == '=')
                                return Parser::make_GREATER_EQUALS(loc);
                            if (yytext[0] == '<' && yytext[1] == '=')
                                return Parser::make_LESS_EQUALS(loc);
                            if (yytext[0] == '<' && yytext[1] == '>')
                                return Parser::make_NOT_EQUALS(loc);
                            if (yytext[0] == '!' && yytext[1] == '=')
                                return Parser::make_NOT_EQUALS(loc);
                        }
                    }
                    /*
                     * Complain if operator is too long.  Unlike the case
                     * for identifiers, we make this an error not a notice-
                     * and-truncate, because the odds are we are looking at
                     * a syntactic mistake anyway. NAMEDDATALEN
                     */
                    if (nchars >= 64)
                        ctx.AddError(loc, "operator too long: operators longer than 64 bytes are not supported");

                    return Parser::make_Op(loc);
                }

{param}         { return ctx.ReadParameter(yytext_view, loc); }
{param2}        { return ctx.ReadParameter(yytext_view, loc); }
{integer}       { return ctx.ReadInteger(yytext_view, loc); }
{decimal}       { return Parser::make_FCONST(loc); }
{decimalfail}   { yyless(yyleng - 2); return Parser::make_FCONST(loc); }
{real}          { return Parser::make_FCONST(loc); }
{realfail1}     { yyless(yyleng - 1); return Parser::make_FCONST(loc); }
{realfail2}     { yyless(yyleng - 2); return Parser::make_FCONST(loc); }

{identifier}    { return ctx.ReadIdentifier(yytext_view, loc); }

{other}         { return Parser::symbol_type(yytext[0], loc); }

<<EOF>>         { return Parser::make_EOF(loc); }
%%

namespace flatsql {
namespace parser {

Scanner::Scanner(std::shared_ptr<TextBuffer> text): input_data(text), current_leaf_node(text->GetRope().GetLeafs()), output(std::make_shared<ScannedScript>(text)) {
    if (current_leaf_node && current_leaf_node->GetSize() == 0) {
        current_leaf_node = nullptr;
    }
    flatsql_yylex_init_extra(this, &internal_scanner_state);

    // Reserve space for the string dictionary
    output->name_dictionary_ids.reserve(128);
    output->name_dictionary.reserve(128);

    // Always encode the empty string with identifier 0
    output->name_dictionary_ids.insert({"", 0});
    output->name_dictionary.push_back({"", sx::Location(0, 0)});
}

Scanner::~Scanner() {
    flatsql_yylex_destroy(internal_scanner_state);
}

}
}
