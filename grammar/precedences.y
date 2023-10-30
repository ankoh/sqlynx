/* Precedence: lowest to highest */
%nonassoc    SET                /* see */
%left        UNION EXCEPT
%left        INTERSECT
%left        OR
%left        AND
%right       NOT
%nonassoc    IS ISNULL NOTNULL    /* IS sets precedence for IS NULL, etc */
%nonassoc    LESS_THAN GREATER_THAN EQUALS LESS_EQUALS GREATER_EQUALS NOT_EQUALS
%nonassoc    BETWEEN IN_P GLOB LIKE ILIKE SIMILAR NOT_LA
%nonassoc    ESCAPE            /* ESCAPE must be just above LIKE/ILIKE/SIMILAR */
%left        POSTFIXOP        /* dummy for postfix Op rules */

/*
 * To support target_el without AS, we must give IDENT an explicit priority
 * between POSTFIXOP and Op.  We can safely assign the same priority to
 * various unreserved keywords as needed to resolve ambiguities (this can't
 * have any bad effects since obviously the keywords will still behave the
 * same as if they weren't keywords).  We need to do this for PARTITION,
 * RANGE, ROWS to support opt_existing_window_name; and for RANGE, ROWS
 * so that they can follow a_expr without creating postfix-operator problems;
 * for GENERATED so that it can follow b_expr;
 * and for NULL so that it can follow b_expr in without creating
 * postfix-operator problems.
 *
 * To support CUBE and ROLLUP in GROUP BY without reserving them, we give them
 * an explicit priority lower than LRB, so that a rule with CUBE LRB will shift
 * rather than reducing a conflicting rule that takes CUBE as a function name.
 * Using the same precedence as IDENT seems right for the reasons given above.
 *
 * The frame_bound productions UNBOUNDED PRECEDING and UNBOUNDED FOLLOWING
 * are even messier: since UNBOUNDED is an unreserved keyword (per spec!),
 * there is no principled way to distinguish these from the productions
 * a_expr PRECEDING/FOLLOWING.  We hack this up by giving UNBOUNDED slightly
 * lower precedence than PRECEDING and FOLLOWING.  At present this doesn't
 * appear to cause UNBOUNDED to be treated differently from other unreserved
 * keywords anywhere else in the grammar, but it's definitely risky.  We can
 * blame any funny behavior of UNBOUNDED on the SQL standard, though.
 */
%nonassoc   UNBOUNDED        /* ideally should have same precedence as IDENT */
%nonassoc   IDENT GENERATED NULL_P PARTITION RANGE ROWS PRECEDING FOLLOWING CUBE ROLLUP
%left       Op OPERATOR        /* multi-character ops and user-defined operators */
%left       PLUS MINUS
%left       STAR DIVIDE MODULO
%left       CIRCUMFLEX
/* Unary Operators */
%left       AT                /* sets precedence for AT TIME ZONE */
%left       COLLATE
%right      UMINUS
%left       LSB RSB
%left       LRB RRB
%left       TYPECAST
%left       DOT

/*
 * These might seem to be low-precedence, but actually they are not part
 * of the arithmetic hierarchy at all in their use as JOIN operators.
 * We make them high-precedence to support their use as function names.
 * They wouldn't be given a precedence at all, were it not that we need
 * left-associativity among the JOIN rules themselves.
 */
%left       JOIN CROSS LEFT FULL RIGHT INNER_P NATURAL
/* kluge to keep from causing shift/reduce conflicts */
%right      PRESERVE STRIP_P
