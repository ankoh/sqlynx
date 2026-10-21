// A calculator grammar with Rust actions.
// Exercises //grammar/rust:tables.rs.m4 with -Dapi.rust.actions=true: typed $n values,
// @n / @$ locations, precedence, default actions, and errors raised from an action.

%code use {
use super::*;
}

%token <i64> NUM "number"
%token PLUS MINUS STAR SLASH LRB RRB
%type <i64> expr

%left PLUS MINUS
%left STAR SLASH
%precedence UMINUS

%start input

%%

input:
    expr                    { ctx.result = Some(($1, @1)); }
  ;

expr:
    NUM                     { $1 }
  | expr PLUS expr          { $1 + $3 }
  | expr MINUS expr         { $1 - $3 }
  | expr STAR expr          { $1 * $3 }
  | expr SLASH expr         {
        if $3 == 0 {
            return Err(ReduceError::DivisionByZero(@3));
        }
        $1 / $3
    }
  | MINUS expr %prec UMINUS { -$2 }
  | LRB expr RRB            { let _ = @$; $2 }
  ;
