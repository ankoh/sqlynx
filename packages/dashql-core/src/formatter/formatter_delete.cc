#include "dashql/formatter/formatter.h"

#include "dashql/formatter/formatting_program.h"

namespace dashql {

using AttributeKey = buffers::parser::AttributeKey;

FmtReg Formatter::FormatDelete(const buffers::parser::Node& node) {
    auto [target, using_clause, where, returning, with_ctes, with_recursive] =
        GetAttributes<AttributeKey::SQL_DELETE_TARGET, AttributeKey::SQL_DELETE_USING,
                      AttributeKey::SQL_DELETE_WHERE, AttributeKey::SQL_DELETE_RETURNING,
                      AttributeKey::SQL_SELECT_WITH_CTES, AttributeKey::SQL_SELECT_WITH_RECURSIVE>(node);
    if (!target || Reg(*target) == 0) return FormatUnimplemented(node);

    std::vector<FmtReg> clauses;
    if (with_ctes) {
        if (Reg(*with_ctes) == 0) return FormatUnimplemented(*with_ctes);
        clauses.push_back(fmt.Concat({fmt.Text(with_recursive ? "with recursive " : "with "), Reg(*with_ctes)}));
    }
    clauses.push_back(fmt.Concat({fmt.Text("delete from "), Reg(*target)}));
    for (auto [child, keyword] : {std::pair{using_clause, "using "}, std::pair{where, "where "},
                                  std::pair{returning, "returning "}}) {
        if (!child) continue;
        if (Reg(*child) == 0) return FormatUnimplemented(*child);
        clauses.push_back(fmt.Concat({fmt.Text(keyword), Reg(*child)}));
    }
    auto policy = config.mode == buffers::formatting::FormattingMode::PRETTY
                      ? FormattingJoinPolicy::ForceBreak
                      : FormattingJoinPolicy::BreakAllOrNone;
    return fmt.Join(clauses, fmt.Text(" "), fmt.Break(), policy);
}

}  // namespace dashql
