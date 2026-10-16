#include "dashql/formatter/formatter.h"

#include "dashql/formatter/formatting_program.h"

namespace dashql {

using AttributeKey = buffers::parser::AttributeKey;
using NodeType = buffers::parser::NodeType;

namespace {

bool IsTrue(const buffers::parser::Node* node) {
    return node && node->node_type() == NodeType::BOOL && node->children_begin_or_value() != 0;
}

}  // namespace

FmtReg Formatter::FormatPropertyGraph(const buffers::parser::Node& node) {
    auto [vertices, edges] =
        GetAttributes<AttributeKey::SQL_PROPERTY_GRAPH_VERTEX_TABLES,
                      AttributeKey::SQL_PROPERTY_GRAPH_EDGE_TABLES>(node);
    std::vector<FmtReg> sections;
    if (vertices && vertices->children_count() > 0) {
        sections.push_back(fmt.Concat({fmt.Text("vertex tables "), fmt.Parenthesized(Reg(*vertices))}));
    }
    if (edges && edges->children_count() > 0) {
        sections.push_back(fmt.Concat({fmt.Text("edge tables "), fmt.Parenthesized(Reg(*edges))}));
    }
    if (sections.empty()) return fmt.Text("");
    auto policy = config.mode == buffers::formatting::FormattingMode::PRETTY
                      ? FormattingJoinPolicy::ForceBreak
                      : FormattingJoinPolicy::BreakOnOverflow;
    return fmt.Join(sections, fmt.Text(" "), fmt.Break(), policy);
}

FmtReg Formatter::FormatGraphElementTable(const buffers::parser::Node& node) {
    auto [table, key, source, destination, labels] =
        GetAttributes<AttributeKey::SQL_GRAPH_ELEMENT_TABLE_TABLE, AttributeKey::SQL_GRAPH_ELEMENT_TABLE_KEY,
                      AttributeKey::SQL_GRAPH_ELEMENT_TABLE_SOURCE,
                      AttributeKey::SQL_GRAPH_ELEMENT_TABLE_DESTINATION,
                      AttributeKey::SQL_GRAPH_ELEMENT_TABLE_LABELS>(node);
    if (!table) return FormatUnimplemented(node);
    auto [table_name, table_alias, table_query] =
        GetAttributes<AttributeKey::SQL_TABLEREF_NAME, AttributeKey::SQL_TABLEREF_ALIAS,
                      AttributeKey::SQL_TABLEREF_TABLE>(*table);
    FmtReg table_reg = Reg(*table);
    if (table_alias) {
        FmtReg base_reg = table_name ? Reg(*table_name) : table_query ? Reg(*table_query) : 0;
        FmtReg alias_reg = Reg(*table_alias);
        if (base_reg == 0 || alias_reg == 0) return FormatUnimplemented(node);
        if (table_query && table_query->node_type() == NodeType::OBJECT_SQL_SELECT) {
            base_reg = fmt.Parenthesized(base_reg);
        }
        table_reg = fmt.Concat({base_reg, fmt.Text(" as "), alias_reg});
    }
    std::vector<FmtReg> parts{table_reg};
    if (key) parts.push_back(fmt.Concat({fmt.Text("key "), fmt.Parenthesized(Reg(*key))}));
    if (source) parts.push_back(fmt.Concat({fmt.Text("source "), Reg(*source)}));
    if (destination) parts.push_back(fmt.Concat({fmt.Text("destination "), Reg(*destination)}));
    if (labels) {
        for (auto& label : GetArrayStates(*labels)) parts.push_back(label.reg);
    }
    auto policy = config.mode == buffers::formatting::FormattingMode::PRETTY
                      ? FormattingJoinPolicy::ForceBreak
                      : FormattingJoinPolicy::BreakOnOverflow;
    return fmt.Join(parts, fmt.Text(" "), fmt.Break(), policy, true);
}

FmtReg Formatter::FormatGraphVertexReference(const buffers::parser::Node& node) {
    auto [name, key, columns] =
        GetAttributes<AttributeKey::SQL_GRAPH_VERTEX_REFERENCE_NAME,
                      AttributeKey::SQL_GRAPH_VERTEX_REFERENCE_KEY,
                      AttributeKey::SQL_GRAPH_VERTEX_REFERENCE_COLUMNS>(node);
    if (!name) return FormatUnimplemented(node);
    if (!key) return Reg(*name);
    auto result = fmt.Concat({fmt.Text("key "), fmt.Parenthesized(Reg(*key)), fmt.Text(" references "), Reg(*name)});
    if (columns && columns->children_count() > 0) result = fmt.Concat({result, fmt.Parenthesized(Reg(*columns))});
    return result;
}

FmtReg Formatter::FormatGraphLabel(const buffers::parser::Node& node) {
    auto [name, is_default, properties] =
        GetAttributes<AttributeKey::SQL_GRAPH_LABEL_NAME, AttributeKey::SQL_GRAPH_LABEL_DEFAULT,
                      AttributeKey::SQL_GRAPH_LABEL_PROPERTIES>(node);
    if (!properties || (!name && !IsTrue(is_default))) return FormatUnimplemented(node);
    auto label = name ? fmt.Concat({fmt.Text("label "), Reg(*name)}) : fmt.Text("default label");
    return fmt.Concat({label, fmt.Text(" "), Reg(*properties)});
}

FmtReg Formatter::FormatGraphProperties(const buffers::parser::Node& node) {
    auto [all, columns, exclude] =
        GetAttributes<AttributeKey::SQL_GRAPH_PROPERTIES_ALL, AttributeKey::SQL_GRAPH_PROPERTIES_COLUMNS,
                      AttributeKey::SQL_GRAPH_PROPERTIES_EXCLUDE>(node);
    if (IsTrue(all)) {
        auto result = fmt.Text("properties are all columns");
        if (exclude && exclude->children_count() > 0) {
            result = fmt.Concat({result, fmt.Text(" except "), fmt.Parenthesized(Reg(*exclude))});
        }
        return result;
    }
    if (columns) return fmt.Concat({fmt.Text("properties "), fmt.Parenthesized(Reg(*columns))});
    return fmt.Text("no properties");
}

FmtReg Formatter::FormatGraphProperty(const buffers::parser::Node& node) {
    auto [value, name] =
        GetAttributes<AttributeKey::SQL_GRAPH_PROPERTY_VALUE, AttributeKey::SQL_GRAPH_PROPERTY_NAME>(node);
    if (!value) return FormatUnimplemented(node);
    return name ? fmt.Concat({Reg(*value), fmt.Text(" as "), Reg(*name)}) : Reg(*value);
}

FmtReg Formatter::FormatGraphTable(const buffers::parser::Node& node) {
    auto [graph, match, rows, columns] =
        GetAttributes<AttributeKey::SQL_GRAPH_TABLE_GRAPH, AttributeKey::SQL_GRAPH_TABLE_MATCH,
                      AttributeKey::SQL_GRAPH_TABLE_ROWS, AttributeKey::SQL_GRAPH_TABLE_COLUMNS>(node);
    if (!graph || !match) return FormatUnimplemented(node);
    std::vector<FmtReg> clauses{Reg(*graph), Reg(*match)};
    if (rows) clauses.push_back(Reg(*rows));
    if (columns) clauses.push_back(fmt.Concat({fmt.Text("columns "), fmt.Parenthesized(Reg(*columns))}));
    auto policy = config.mode == buffers::formatting::FormattingMode::PRETTY
                      ? FormattingJoinPolicy::ForceBreak
                      : FormattingJoinPolicy::BreakOnOverflow;
    auto body = fmt.Join(clauses, fmt.Text(" "), fmt.Break(), policy, true);
    if (config.mode == buffers::formatting::FormattingMode::PRETTY) {
        return fmt.Concat({fmt.Text("graph_table("), fmt.Indented(fmt.Concat({fmt.Break(), body})), fmt.Break(),
                           fmt.Text(")")});
    }
    return fmt.Concat({fmt.Text("graph_table"), fmt.Parenthesized(body)});
}

FmtReg Formatter::FormatGraphMatch(const buffers::parser::Node& node) {
    auto [patterns, where] =
        GetAttributes<AttributeKey::SQL_GRAPH_MATCH_PATTERNS, AttributeKey::SQL_GRAPH_MATCH_WHERE>(node);
    if (!patterns) return FormatUnimplemented(node);
    auto result = fmt.Concat({fmt.Text("match "), Reg(*patterns)});
    return where ? fmt.Concat({result, fmt.Text(" where "), Reg(*where)}) : result;
}

FmtReg Formatter::FormatGraphPathElement(const buffers::parser::Node& node) {
    auto [vertex, left, right, any, variable, label, where, quantifier] =
        GetAttributes<AttributeKey::SQL_GRAPH_PATH_ELEMENT_VERTEX, AttributeKey::SQL_GRAPH_PATH_ELEMENT_EDGE_LEFT,
                      AttributeKey::SQL_GRAPH_PATH_ELEMENT_EDGE_RIGHT,
                      AttributeKey::SQL_GRAPH_PATH_ELEMENT_EDGE_ANY,
                      AttributeKey::SQL_GRAPH_PATH_ELEMENT_VARIABLE,
                      AttributeKey::SQL_GRAPH_PATH_ELEMENT_LABEL, AttributeKey::SQL_GRAPH_PATH_ELEMENT_WHERE,
                      AttributeKey::SQL_GRAPH_PATH_ELEMENT_QUANTIFIER>(node);
    std::vector<FmtReg> body_parts;
    if (variable) body_parts.push_back(Reg(*variable));
    if (label) body_parts.push_back(fmt.Concat({fmt.Text(":"), Reg(*label)}));
    if (where) body_parts.push_back(fmt.Concat({fmt.Text("where "), Reg(*where)}));
    // Path element bodies are short and must not wrap, breaks happen between path elements instead.
    std::vector<FmtReg> spaced_parts;
    for (size_t i = 0; i < body_parts.size(); ++i) {
        if (i > 0) spaced_parts.push_back(fmt.Text(" "));
        spaced_parts.push_back(body_parts[i]);
    }
    auto body = fmt.Concat(std::move(spaced_parts));
    FmtReg result;
    if (IsTrue(vertex)) {
        result = body == 0 ? fmt.Text("()") : fmt.Concat({fmt.Text("("), body, fmt.Text(")")});
    } else if (IsTrue(left)) {
        result = fmt.Concat({fmt.Text("<-["), body, fmt.Text("]-")});
    } else if (IsTrue(right)) {
        result = fmt.Concat({fmt.Text("-["), body, fmt.Text("]->")});
    } else if (IsTrue(any)) {
        result = fmt.Concat({fmt.Text("-["), body, fmt.Text("]-")});
    } else {
        return FormatUnimplemented(node);
    }
    return quantifier ? fmt.Concat({result, Reg(*quantifier)}) : result;
}

FmtReg Formatter::FormatGraphQuantifier(const buffers::parser::Node& node) {
    auto [lower, upper, fixed] =
        GetAttributes<AttributeKey::SQL_GRAPH_QUANTIFIER_LOWER, AttributeKey::SQL_GRAPH_QUANTIFIER_UPPER,
                      AttributeKey::SQL_GRAPH_QUANTIFIER_FIXED>(node);
    if (IsTrue(fixed)) {
        if (!lower) return FormatUnimplemented(node);
        return fmt.Concat({fmt.Text("{"), Reg(*lower), fmt.Text("}")});
    }
    return fmt.Concat({fmt.Text("{"), lower ? Reg(*lower) : fmt.Empty(), fmt.Text(","),
                       upper ? Reg(*upper) : fmt.Empty(), fmt.Text("}")});
}

FmtReg Formatter::FormatGraphLabelExpression(const buffers::parser::Node& node) {
    auto [label, wildcard, negated, left, right, disjunction] =
        GetAttributes<AttributeKey::SQL_GRAPH_LABEL_EXPRESSION_LABEL,
                      AttributeKey::SQL_GRAPH_LABEL_EXPRESSION_WILDCARD,
                      AttributeKey::SQL_GRAPH_LABEL_EXPRESSION_NEGATED,
                      AttributeKey::SQL_GRAPH_LABEL_EXPRESSION_LEFT,
                      AttributeKey::SQL_GRAPH_LABEL_EXPRESSION_RIGHT,
                      AttributeKey::SQL_GRAPH_LABEL_EXPRESSION_DISJUNCTION>(node);
    if (label) return Reg(*label);
    if (IsTrue(wildcard)) return fmt.Text("%");
    if (IsTrue(negated)) return left ? fmt.Concat({fmt.Text("!"), Reg(*left)}) : FormatUnimplemented(node);
    if (!left || !right) return FormatUnimplemented(node);
    auto op = IsTrue(disjunction) ? fmt.Text(" | ") : fmt.Text(" & ");
    return fmt.Concat({Reg(*left), op, Reg(*right)});
}

FmtReg Formatter::FormatGraphRows(const buffers::parser::Node& node) {
    auto [per_match, per_step, source, edge, destination] =
        GetAttributes<AttributeKey::SQL_GRAPH_ROWS_PER_MATCH, AttributeKey::SQL_GRAPH_ROWS_PER_STEP,
                      AttributeKey::SQL_GRAPH_ROWS_SOURCE, AttributeKey::SQL_GRAPH_ROWS_EDGE,
                      AttributeKey::SQL_GRAPH_ROWS_DESTINATION>(node);
    if (IsTrue(per_match)) return fmt.Text("one row per match");
    if (!IsTrue(per_step) || !source || !edge || !destination) return FormatUnimplemented(node);
    auto vars = fmt.Concat({Reg(*source), fmt.Text(", "), Reg(*edge), fmt.Text(", "), Reg(*destination)});
    return fmt.Concat({fmt.Text("one row per step"), fmt.Parenthesized(vars)});
}

}  // namespace dashql
