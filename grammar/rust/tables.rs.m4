                                                            -*- Autoconf -*-
# Bison skeleton that emits the LALR(1) automaton of a grammar as Rust.
#
# This is NOT a parser skeleton. It emits only data plus the user actions:
#
#   - the integral parser tables (yypact, yydefact, yypgoto, yydefgoto, yytable,
#     yycheck, yystos, yyr1, yyr2, yyrline) as `pub static` slices,
#   - the automaton constants (YYNTOKENS, YYLAST, YYFINAL, ...),
#   - the symbol names (yytname) for verbose error messages,
#   - one `pub const S_*: u16` per symbol kind (mirrors bison's C++ symbol_kind),
#   - optionally (-Dapi.rust.actions=true) a `reduce` function that dispatches the
#     user actions of the grammar by rule number.
#
# The LR driver (parse loop, LAC, error recovery, completion probes) is hand-written
# Rust and lives in the consuming crate. Keeping it out of the skeleton lets the
# completion engine drive the tables directly, exactly as the C++ core does.
#
# `%code use { ... }` blocks are emitted at the top of the file, e.g. to import the types
# below into the generated module.
#
# Rust actions are block expressions: the value of the block is the semantic value
# of the left-hand side (`$$` is not supported). `$n` reads the value of the n-th
# right-hand symbol (all semantic values are `Copy`), `@n` / `@$` read locations.
# The expansion is generic over these items provided by the consuming crate:
#
#   type Value;                                 // the stack value (an enum)
#   trait FromValue: Sized { fn from_value(v: Value) -> Self; }
#   impl From<T> for Value                      // for every %type / %token tag T
#   trait ReduceStack {                         // the parser stack
#       fn value_at(&self, i: usize) -> Value;  // i = 0 is the top of the stack
#       fn location_at(&self, i: usize) -> Location;
#   }
#
# Usage (see //grammar/rust:defs.bzl):
#   bison -S tables.rs.m4 [-Dapi.rust.actions=true] -o out.rs grammar.y

m4_include(b4_skeletonsdir/[c-like.m4])

## ------------------- ##
## Language settings.  ##
## ------------------- ##

b4_percent_define_default([[api.symbol.prefix]], [[S_]])
b4_percent_define_default([[api.rust.actions]], [[false]])
b4_percent_define_default([[api.rust.context]], [[ParseContext]])
b4_percent_define_default([[api.rust.location]], [[Location]])
b4_percent_define_default([[api.rust.error]], [[ReduceError]])

m4_define([b4_rust_actions_if],
[b4_percent_define_flag_if([[api.rust.actions]], [$1], [$2])])

# The C++ grammar prologue defines options for lalr1.cc (variants, token
# constructors, ...). They are irrelevant for table emission; mark them as used so
# that bison does not complain when the same grammar is fed to this skeleton.
b4_percent_define_use([[api.namespace]])
b4_percent_define_use([[api.parser.class]])
b4_percent_define_use([[api.token.constructor]])
b4_percent_define_use([[api.token.prefix]])
b4_percent_define_use([[api.value.type]])
b4_percent_define_use([[api.location.type]])
b4_percent_define_use([[parse.error]])
b4_percent_define_use([[parse.lac]])
b4_percent_define_use([[api.token.raw]])
m4_define([b4_percent_code_bison_qualifiers(requires)])

## ------------ ##
## Data types.  ##
## ------------ ##

# b4_int_type(MIN, MAX)
# ---------------------
# The narrowest Rust integer type that holds MIN..MAX.
m4_define([b4_int_type],
[m4_if(b4_ints_in($@,    [-128],   [127]), [1], [i8],
       b4_ints_in($@,       [0],   [255]), [1], [u8],
       b4_ints_in($@,  [-32768], [32767]), [1], [i16],
       b4_ints_in($@,       [0], [65535]), [1], [u16],
                                                [i32])])

m4_define([b4_int_type_for],
[b4_int_type($1_min, $1_max)])

m4_define([b4_null], [""])

# b4_integral_parser_table_define(NAME, DATA, COMMENT)
# ----------------------------------------------------
m4_define([b4_integral_parser_table_define],
[m4_ifval([$3], [b4_comment([$3], [])
])dnl
[pub static YY]m4_toupper([$1])[: &@{]b4_int_type_for([$2])[@} = &@{
  ]$2[
@};
]])

## ---------- ##
## Comments.  ##
## ---------- ##

m4_define([b4_comment],
[_b4_comment([$1], [$2// ], [$2// ], [])])

# Synclines would be `#line` directives in C; emit a comment instead.
m4_define([b4_sync_start], [// $2:$1])

## -------------- ##
## Symbol kinds.  ##
## -------------- ##

# b4_symbol_kind_const(SYMBOL-NUM)
# --------------------------------
m4_define([b4_symbol_kind_const],
[m4_format([[pub const %s: u16 = %s;]], b4_symbol([$1], [kind_base]), [$1])
])

## ----------------- ##
## Semantic values.  ##
## ----------------- ##

# b4_symbol_value(VAL, [SYMBOL-NUM], [TYPE-TAG])
# ----------------------------------------------
# Convert the stack value VAL into the Rust type of the symbol (if typed).
m4_define([b4_symbol_value],
[m4_ifval([$3],
          [<$3 as FromValue>::from_value($1)],
          [m4_ifval([$2],
                    [b4_symbol_if([$2], [has_type],
                                  [<b4_symbol([$2], [type]) as FromValue>::from_value($1)],
                                  [$1])],
                    [$1])])])

# b4_lhs_value(SYMBOL-NUM, [TYPE])
# --------------------------------
# Rust actions are block expressions, $$ is not available.
m4_define([b4_lhs_value],
[m4_fatal([$$ is not supported by the Rust table skeleton, actions are block expressions])])

# b4_rhs_value(RULE-LENGTH, POS, SYMBOL-NUM, [TYPE])
# --------------------------------------------------
m4_define([b4_rhs_value],
[b4_symbol_value([yystack.value_at(b4_subtract([$1], [$2]))], [$3], [$4])])

# b4_lhs_location()
# -----------------
m4_define([b4_lhs_location],
[yyloc])

# b4_rhs_location(RULE-LENGTH, POS)
# ---------------------------------
m4_define([b4_rhs_location],
[yystack.location_at(b4_subtract([$1], [$2]))])

# b4_case(LABEL, STATEMENTS, [COMMENTS])
# --------------------------------------
m4_define([b4_case],
[        $1 => {m4_ifval([$3], [ b4_comment([$3])])
            let yyvalue = $2;
            Ok(Value::from(yyvalue))
        }
])

## -------- ##
## Output.  ##
## -------- ##

b4_output_begin([b4_parser_file_name])[
// Generated by GNU Bison ]b4_version_string[ from ]b4_file_name[ using //grammar/rust:tables.rs.m4.
// DO NOT EDIT.
//
// Declare this module with
// #[allow(dead_code, non_upper_case_globals, unused_braces, unused_parens, unused_variables)].
]b4_percent_code_get([[use]])[

/// The number of terminal symbols (including EOF, error, and undef).
pub const YYNTOKENS: usize = ]b4_tokens_number[;
/// The number of nonterminal symbols (including $accept).
pub const YYNNTS: usize = ]b4_nterms_number[;
/// The number of rules.
pub const YYNRULES: usize = ]b4_rules_number[;
/// The number of states.
pub const YYNSTATES: usize = ]b4_states_number[;
/// The last index in YYTABLE.
pub const YYLAST: i32 = ]b4_last[;
/// The termination state number.
pub const YYFINAL: i32 = ]b4_final_state_number[;
/// YYPACT value that marks a state with a default reduction.
pub const YYPACT_NINF: i32 = ]b4_pact_ninf[;
/// YYTABLE value that marks a syntax error.
pub const YYTABLE_NINF: i32 = ]b4_table_ninf[;

]b4_parser_tables_define[
]b4_integral_parser_table_define([rline], [b4_rline],
     [[YYRLINE[YYN] -- Source line where rule number YYN was defined.]])[

const YY_NULLPTR: &str = "";

/// YYTNAME[SYMBOL-NUM] -- String name of the symbol SYMBOL-NUM, terminals first.
pub static YYTNAME: &@{&str@} = &@{
  ]b4_tname[
@};

/// Symbol kinds, numbered like bison's C++ `symbol_kind`.
pub mod symbol_kind {
]b4_symbol_foreach([b4_symbol_kind_const])[}
]b4_rust_actions_if([[
/// Run the user action of rule YYN.
///
/// `yystack` holds the right-hand side of the rule, the top of the stack being the
/// last symbol. `yyloc` is the location of the left-hand side. Rules without an
/// action return `Ok(None)`, the caller applies the default action.
pub fn reduce(
    ctx: &mut ]b4_percent_define_get([[api.rust.context]])[,
    yyn: usize,
    yystack: &impl ReduceStack,
    yyloc: ]b4_percent_define_get([[api.rust.location]])[,
) -> Result<Option<Value>, ]b4_percent_define_get([[api.rust.error]])[> {
    let yyresult: Result<Value, ]b4_percent_define_get([[api.rust.error]])[> = match yyn {
]b4_user_actions[
        _ => return Ok(None),
    };
    yyresult.map(Some)
}
]])[
]b4_percent_code_get([[epilogue]])[]dnl
b4_epilogue[]dnl
b4_output_end
