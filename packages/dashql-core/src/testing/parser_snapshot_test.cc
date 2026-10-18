#include "dashql/testing/parser_snapshot_test.h"

#include <cstdint>
#include <fstream>
#include <iostream>
#include <sstream>
#include <unordered_map>

#include "c4/yml/std/std.hpp"
#include "dashql/testing/runfiles_dir.h"
#include "dashql/buffers/index_generated.h"
#include "dashql/parser/grammar/enums.h"
#include "dashql/testing/yaml_tests.h"
#include "dashql/utils/string_trimming.h"
#include "ryml.hpp"

namespace dashql::testing {

void operator<<(std::ostream& out, const ParserSnapshotTest& p) { out << p.name; }

static buffers::parser::TextSpan ResolveSpan(const ScannedScript* scanned, buffers::parser::SymbolSpan span) {
    if (scanned) return scanned->ResolveTextSpan(span);
    return buffers::parser::TextSpan(span.offset(), span.length());
}

static void EncodeASTNode(c4::yml::NodeRef n, std::string_view text, const ScannedScript* scanned,
                          std::span<const buffers::parser::Node> ast, size_t node_id) {
    const auto* target = &ast[node_id];
    auto* node_type_tt = buffers::parser::NodeTypeTypeTable();

    if (target->attribute_key() != buffers::parser::AttributeKey::NONE) {
        auto name = buffers::parser::EnumNameAttributeKey(target->attribute_key());
        n.append_child() << c4::yml::key("key") << name;
    }

    n.append_child() << c4::yml::key("type")
                     << std::string(node_type_tt->names[static_cast<uint16_t>(target->node_type())]);

    switch (target->node_type()) {
        case buffers::parser::NodeType::NONE:
            break;
        case buffers::parser::NodeType::BOOL: {
            n.append_child() << c4::yml::key("value") << (target->children_begin_or_value() != 0);
            break;
        }
        case buffers::parser::NodeType::OPERATOR:
        case buffers::parser::NodeType::NAME:
        case buffers::parser::NodeType::LITERAL_NULL:
        case buffers::parser::NodeType::LITERAL_FLOAT:
        case buffers::parser::NodeType::LITERAL_INTEGER:
        case buffers::parser::NodeType::LITERAL_INTERVAL:
        case buffers::parser::NodeType::LITERAL_STRING: {
            EncodeLocationText(n, ResolveSpan(scanned, target->symbol_span()), text);
            break;
        }
        case buffers::parser::NodeType::ARRAY: {
            EncodeLocationText(n, ResolveSpan(scanned, target->symbol_span()), text);
            auto nodes_key = n.append_child();
            nodes_key << c4::yml::key("children");
            nodes_key |= c4::yml::SEQ;
            size_t begin = target->children_begin_or_value();
            for (size_t i = 0; i < target->children_count(); ++i) {
                auto item = nodes_key.append_child();
                item.set_type(c4::yml::MAP);
                EncodeASTNode(item, text, scanned, ast, begin + i);
            }
            break;
        }
        default: {
            auto node_type_id = static_cast<uint32_t>(target->node_type());
            if (node_type_id > static_cast<uint32_t>(buffers::parser::NodeType::OBJECT_KEYS_)) {
                EncodeLocationText(n, ResolveSpan(scanned, target->symbol_span()), text);
                auto nodes_key = n.append_child();
                nodes_key << c4::yml::key("children");
                nodes_key |= c4::yml::SEQ;
                size_t begin = target->children_begin_or_value();
                for (size_t i = 0; i < target->children_count(); ++i) {
                    auto item = nodes_key.append_child();
                    item.set_type(c4::yml::MAP);
                    EncodeASTNode(item, text, scanned, ast, begin + i);
                }
            } else if (node_type_id > static_cast<uint32_t>(buffers::parser::NodeType::ENUM_KEYS_)) {
                n.append_child() << c4::yml::key("value") << std::string(dashql::parser::getEnumText(*target));
            } else {
                n.append_child() << c4::yml::key("value") << target->children_begin_or_value();
            }
            break;
        }
    }
}

void ParserSnapshotTest::EncodeAST(c4::yml::NodeRef parent, std::string_view text, const ScannedScript& scanned,
                                   std::span<const buffers::parser::Node> ast, size_t root_node_id) {
    auto node_container = parent.append_child();
    node_container << c4::yml::key("ast");
    node_container |= c4::yml::MAP;
    EncodeASTNode(node_container, text, &scanned, ast, root_node_id);
}

void ParserSnapshotTest::EncodeAST(c4::yml::NodeRef parent, std::string_view text,
                                   std::span<const buffers::parser::Node> ast, size_t root_node_id) {
    auto node_container = parent.append_child();
    node_container << c4::yml::key("ast");
    node_container |= c4::yml::MAP;
    EncodeASTNode(node_container, text, nullptr, ast, root_node_id);
}

void ParserSnapshotTest::EncodeScript(c4::yml::NodeRef root, const ScannedScript& scanned, const ParsedScript& parsed,
                                      std::string_view text) {
    auto& nodes = parsed.nodes;
    auto& statements = parsed.statements;
    auto descriptions = parsed.AssociateDescriptions();
    auto stmts_node = root.append_child();
    stmts_node << c4::yml::key("statements");
    stmts_node |= c4::yml::SEQ;
    for (unsigned stmt_id = 0; stmt_id < statements.size(); ++stmt_id) {
        auto& s = statements[stmt_id];
        auto stmt = stmts_node.append_child();
        stmt.set_type(c4::yml::MAP);
        stmt.append_child() << c4::yml::key("type") << std::string(buffers::parser::EnumNameStatementType(s.type));
        stmt.append_child() << c4::yml::key("ast-begin") << s.nodes_begin;
        stmt.append_child() << c4::yml::key("ast-size") << s.node_count;
        auto& description = descriptions[stmt_id];
        auto description_node = stmt.append_child();
        description_node << c4::yml::key("description");
        description_node |= c4::yml::MAP;
        EncodeLocationText(description_node, description.source_span, text);
        description_node.append_child() << c4::yml::key("description-begin") << description.description_begin;
        description_node.append_child() << c4::yml::key("description-count") << description.description_count;
        if (description.description_block != PROTO_NULL_U32) {
            description_node.append_child() << c4::yml::key("description-block") << description.description_block;
        }
        ParserSnapshotTest::EncodeAST(stmt, text, scanned, nodes, s.root);
    }

    auto scanner_errors_node = root.append_child();
    scanner_errors_node << c4::yml::key("scanner-errors");
    scanner_errors_node |= c4::yml::SEQ;
    for (auto& [err_loc, err_msg] : scanned.errors) {
        auto err_node = scanner_errors_node.append_child();
        err_node.set_type(c4::yml::MAP);
        err_node.append_child() << c4::yml::key("message") << err_msg;
        EncodeLocationText(err_node, err_loc, text);
    }

    auto parser_errors_node = root.append_child();
    parser_errors_node << c4::yml::key("parser-errors");
    parser_errors_node |= c4::yml::SEQ;
    for (auto& parser_error : parsed.errors) {
        auto err_node = parser_errors_node.append_child();
        err_node.set_type(c4::yml::MAP);
        err_node.append_child() << c4::yml::key("message") << parser_error.message;
        EncodeLocationText(err_node, scanned.ResolveTextSpan(parser_error.location), text);
        if (!parser_error.hint.empty()) {
            err_node.append_child() << c4::yml::key("hint") << parser_error.hint;
        }
    }

    auto line_breaks_node = root.append_child();
    line_breaks_node << c4::yml::key("line-breaks");
    line_breaks_node |= c4::yml::SEQ;
    for (auto& lb : scanned.line_breaks) {
        auto lb_node = line_breaks_node.append_child();
        lb_node.set_type(c4::yml::MAP);
        EncodeLocationRange(lb_node, lb, text);
    }

    auto comments_node = root.append_child();
    comments_node << c4::yml::key("comments");
    comments_node |= c4::yml::SEQ;
    for (auto& comment : scanned.comments) {
        auto comment_node = comments_node.append_child();
        comment_node.set_type(c4::yml::MAP);
        EncodeLocationText(comment_node, comment, text);
    }

    auto blocks_node = root.append_child();
    blocks_node << c4::yml::key("comment-blocks");
    blocks_node |= c4::yml::SEQ;
    for (auto& block : parsed.comment_blocks.blocks) {
        auto block_node = blocks_node.append_child();
        block_node.set_type(c4::yml::MAP);
        block_node.append_child() << c4::yml::key("type")
                                  << std::string(buffers::parser::EnumNameCommentBlockType(block.block_type()));
        EncodeLocationText(block_node, block.text_span(), text);
        if (block.tag_span().length() > 0) {
            EncodeLocationText(block_node, block.tag_span(), text, "tag");
        }
        auto comments_range = block_node.append_child();
        comments_range << c4::yml::key("comments");
        comments_range |= c4::yml::SEQ;
        comments_range.set_container_style(c4::yml::FLOW_SL);
        comments_range.append_child() << block.comments_begin();
        comments_range.append_child() << block.comments_count();
        auto lines_node = block_node.append_child();
        lines_node << c4::yml::key("lines");
        lines_node |= c4::yml::SEQ;
        for (size_t i = 0; i < block.lines_count(); ++i) {
            auto& line = parsed.comment_blocks.lines[block.lines_begin() + i];
            auto line_node = lines_node.append_child();
            line_node << std::string(text.substr(line.offset(), line.length()));
            line_node.set_val_style(c4::yml::VAL_DQUO);
        }
    }
    auto warnings_node = root.append_child();
    warnings_node << c4::yml::key("comment-warnings");
    warnings_node |= c4::yml::SEQ;
    for (auto& [span, message] : parsed.comment_blocks.warnings) {
        auto warning_node = warnings_node.append_child();
        warning_node.set_type(c4::yml::MAP);
        warning_node.append_child() << c4::yml::key("message") << message;
        EncodeLocationText(warning_node, span, text);
    }
}

struct ParserSnapshotFile {
    std::string content;
    c4::yml::Tree tree;
    std::vector<ParserSnapshotTest> tests;
};

static std::unordered_map<std::string, ParserSnapshotFile> TEST_FILES;

void ParserSnapshotTest::LoadTests(const std::filesystem::path& snapshots_dir) {
    if (!TEST_FILES.empty()) return;
    std::cout << "Loading parser snapshot tests at: " << snapshots_dir << std::endl;

    for (auto& p : std::filesystem::directory_iterator(snapshots_dir)) {
        auto filename = p.path().filename().string();
        if (p.path().extension().string() != ".yaml") continue;

        std::ifstream in(p.path(), std::ios::in | std::ios::binary);
        if (!in) {
            std::cout << "[ SETUP    ] failed to read test file: " << filename << std::endl;
            continue;
        }
        std::stringstream buf;
        buf << in.rdbuf();
        std::string content = buf.str();

        ParserSnapshotFile file;
        file.content = std::move(content);
        c4::yml::parse_in_arena(c4::to_csubstr(file.content), &file.tree);

        auto root = file.tree.rootref();
        if (!root.has_child("parser-snapshots")) {
            std::cout << "[ SETUP    ] " << filename << ": no parser-snapshots key" << std::endl;
            continue;
        }
        auto snapshots = root["parser-snapshots"];
        for (auto child : snapshots.children()) {
            ParserSnapshotTest t;
            if (child.has_child("name")) {
                c4::csubstr v = child["name"].val();
                t.name = v.str ? std::string(v.str, v.len) : std::string();
            }
            if (child.has_child("input")) {
                c4::csubstr v = child["input"].val();
                t.input = v.str ? std::string(trim_view_right(
                    trim_view_left(std::string_view{v.str, v.len}, is_no_space), is_no_newline)) : std::string();
            }
            if (child.has_child("debug")) {
                c4::csubstr v = child["debug"].val();
                t.debug = (v == "true" || v == "1");
            }
            if (!child.has_child("expected")) continue;  // skip template-only entries
            t.tree = &file.tree;
            t.node_id = child.id();
            file.tests.push_back(std::move(t));
        }

        std::cout << "[ SETUP    ] " << filename << ": " << file.tests.size() << " tests" << std::endl;
        auto it = TEST_FILES.insert({filename, std::move(file)}).first;
        for (auto& t : it->second.tests) t.tree = &it->second.tree;
    }
}

std::vector<const ParserSnapshotTest*> ParserSnapshotTest::GetTests(std::string_view filename) {
    if (TEST_FILES.empty()) {
        auto root = GetRunfilesSnapshotRoot();
        LoadTests((root.empty() ? std::filesystem::path(".") : root) / "snapshots" / "parser");
    }
    std::string name{filename};
    auto it = TEST_FILES.find(name);
    if (it == TEST_FILES.end()) return {};
    std::vector<const ParserSnapshotTest*> out;
    for (auto& t : it->second.tests) out.push_back(&t);
    return out;
}

}  // namespace dashql::testing
