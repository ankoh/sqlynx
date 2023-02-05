#include "flatsql/parser/parser_driver.h"

#include <iostream>
#include <regex>
#include <sstream>
#include <unordered_map>
#include <unordered_set>

#include "flatsql/parser/grammar/nodes.h"
#include "flatsql/parser/parser.h"
#include "flatsql/parser/scanner.h"
#include "flatsql/proto/proto_generated.h"

namespace flatsql {
namespace parser {

/// Constructor
Statement::Statement() : root() {}

/// Reset the statement
void Statement::reset() { root = std::numeric_limits<uint32_t>::max(); }

/// Finish a statement
std::unique_ptr<proto::StatementT> Statement::Finish() {
    auto stmt = std::make_unique<proto::StatementT>();
    stmt->statement_type = type;
    stmt->root_node = root;
    return stmt;
}

/// Constructor
ParserDriver::ParserDriver(Scanner& scanner)
    : scanner_(scanner), nodes_(), current_statement_(), statements_(), errors_(), vararg_keys_(), dson_key_map_() {}

/// Destructor
ParserDriver::~ParserDriver() {}

/// Find an attribute
std::optional<size_t> ParserDriver::FindAttribute(const proto::Node& node, Key attribute) const {
    auto attr_begin = node.children_begin_or_value();
    auto attr_count = node.children_count();
    for (auto i = 0; i < attr_count; ++i) {
        auto& attr = nodes_[attr_begin + i];
        if (attr.attribute_key() == static_cast<uint16_t>(attribute)) {
            return {attr_begin + i};
        }
    }
    return std::nullopt;
}

/// Process a new node
NodeID ParserDriver::AddNode(proto::Node node) {
    auto node_id = nodes_.size();
    nodes_.push_back(proto::Node(node.location(), node.node_type(), node.attribute_key(), node_id,
                                 node.children_begin_or_value(), node.children_count()));

    // Set parent reference
    if (node.node_type() == proto::NodeType::ARRAY ||
        static_cast<uint16_t>(node.node_type()) > static_cast<uint16_t>(proto::NodeType::OBJECT_KEYS_)) {
        auto begin = node.children_begin_or_value();
        auto end = begin + node.children_count();
        for (auto i = begin; i < end; ++i) {
            auto& n = nodes_[i];
            n = proto::Node(n.location(), n.node_type(), n.attribute_key(), node_id, n.children_begin_or_value(),
                            n.children_count());
        }
    }
    return node_id;
}

/// Add an array
proto::Node ParserDriver::AddArray(proto::Location loc, nonstd::span<proto::Node> values, bool null_if_empty,
                                   bool shrink_location) {
    auto begin = nodes_.size();
    nodes_.reserve(nodes_.size() + values.size());
    for (auto& v : values) {
        if (v.node_type() == proto::NodeType::NONE) continue;
        AddNode(v);
    }
    auto n = nodes_.size() - begin;
    if ((n == 0) && null_if_empty) {
        return Null();
    }
    if (n > 0 && shrink_location) {
        auto fstBegin = nodes_[begin].location().offset();
        auto lstEnd = nodes_.back().location().offset() + nodes_.back().location().length();
        loc = proto::Location(fstBegin, lstEnd - fstBegin);
    }
    return proto::Node(loc, proto::NodeType::ARRAY, 0, NO_PARENT, begin, n);
}

/// Add an object
proto::Node ParserDriver::AddObject(proto::Location loc, proto::NodeType type, nonstd::span<proto::Node> attrs,
                                    bool null_if_empty, bool shrink_location) {
    // Sort all the attributes
    auto begin = nodes_.size();
    nodes_.reserve(nodes_.size() + attrs.size());
    std::sort(attrs.begin(), attrs.end(), [&](auto& l, auto& r) {
        return static_cast<uint16_t>(l.attribute_key()) < static_cast<uint16_t>(r.attribute_key());
    });
    // Find duplicate ranges.
    // We optimize the fast path here and try to add as little overhead as possible for duplicate-free attributes.
    std::vector<nonstd::span<proto::Node>> duplicates;
    for (size_t i = 0, j = 1; j < attrs.size(); i = j++) {
        for (; j < attrs.size() && attrs[j].attribute_key() == attrs[i].attribute_key(); ++j)
            ;
        if ((j - i) == 1) continue;
        duplicates.emplace_back(attrs.data() + i, j - i);
    }
    // Merge attributes if there are any
    std::vector<proto::Node> merged_attrs;
    if (duplicates.size() > 0) {
        merged_attrs.reserve(attrs.size());

        auto* reader = attrs.data();
        std::vector<proto::Node> tmp;
        for (auto dups : duplicates) {
            // Copy attributes until first duplicate
            for (; reader != dups.data(); ++reader) merged_attrs.push_back(*reader);
            reader = dups.end();

            // Only keep first if its not an object
            auto& fst = dups[0];
            if (fst.node_type() < proto::NodeType::OBJECT_KEYS_) {
                merged_attrs.push_back(fst);
                continue;
            }
            // Otherwise merge child attributes
            size_t child_count = 0;
            for (auto dup : dups) child_count += dup.children_count();
            tmp.clear();
            tmp.reserve(child_count);
            for (auto dup : dups) {
                for (size_t l = 0; l < dup.children_count(); ++l) {
                    tmp.push_back(nodes_[dup.children_begin_or_value() + l]);
                }
            }
            // Add object.
            // Note that this will recursively merge paths such as style.data.fill and style.data.stroke
            auto merged = AddObject(fst.location(), fst.node_type(), merged_attrs, true, true);
            merged_attrs.push_back(merged);
        }
        for (; reader != attrs.end(); ++reader) merged_attrs.push_back(*reader);

        // Replace attributes
        attrs = {merged_attrs};
    }
    // Add the nodes
    for (auto& v : attrs) {
        if (v.node_type() == proto::NodeType::NONE) continue;
        AddNode(v);
    }
    auto n = nodes_.size() - begin;
    if ((n == 0) && null_if_empty) {
        return Null();
    }
    if (n > 0 && shrink_location) {
        auto fstBegin = nodes_[begin].location().offset();
        auto lstEnd = nodes_.back().location().offset() + nodes_.back().location().length();
        loc = proto::Location(fstBegin, lstEnd - fstBegin);
    }
    return proto::Node(loc, type, 0, NO_PARENT, begin, n);
}

static std::regex IMPORT_URI_HTTP{"^https?://.*"};

/// Add a statement
void ParserDriver::AddStatement(proto::Node node) {
    if (node.node_type() == proto::NodeType::NONE) {
        return;
    }
    current_statement_.root = AddNode(node);
    auto stmt_type = proto::StatementType::NONE;
    switch (node.node_type()) {
        case proto::NodeType::OBJECT_SQL_CREATE_AS:
            stmt_type = proto::StatementType::CREATE_TABLE_AS;
            break;

        case proto::NodeType::OBJECT_SQL_CREATE:
            stmt_type = proto::StatementType::CREATE_TABLE;
            break;

        case proto::NodeType::OBJECT_SQL_VIEW:
            stmt_type = proto::StatementType::CREATE_VIEW;
            break;

        case proto::NodeType::OBJECT_SQL_SELECT:
            if (auto into = FindAttribute(node, Key::SQL_SELECT_INTO); into) {
                stmt_type = proto::StatementType::SELECT_INTO;
            } else {
                stmt_type = proto::StatementType::SELECT;
            }
            break;

        default:
            assert(false);
    }
    current_statement_.type = stmt_type;
    statements_.push_back(std::move(current_statement_));
    current_statement_.reset();
}

/// Add an error
void ParserDriver::AddError(proto::Location loc, const std::string& message) { errors_.push_back({loc, message}); }

/// Get as flatbuffer object
std::shared_ptr<proto::ProgramT> ParserDriver::Finish() {
    auto program = std::make_unique<proto::ProgramT>();
    program->nodes = std::move(nodes_);
    program->statements.reserve(statements_.size());
    for (auto& stmt : statements_) {
        program->statements.push_back(stmt.Finish());
    }
    program->errors.reserve(errors_.size());
    for (auto& [loc, msg] : errors_) {
        auto err = std::make_unique<proto::ErrorT>();
        err->location = std::make_unique<proto::Location>(loc);
        err->message = std::move(msg);
        program->errors.push_back(std::move(err));
    }
    program->vararg_keys = std::move(vararg_keys_);
    program->highlighting = scanner_.BuildHighlighting();
    program->line_breaks = scanner_.ReleaseLineBreaks();
    program->comments = scanner_.ReleaseComments();
    return program;
}

std::shared_ptr<proto::ProgramT> ParserDriver::Parse(std::string_view in, bool trace_scanning, bool trace_parsing) {
    // XXX shortcut until tests are migrated
    std::vector<char> padded_buffer{in.begin(), in.end()};
    padded_buffer.push_back(0);
    padded_buffer.push_back(0);

    Scanner scanner{padded_buffer};
    scanner.Produce();
    ParserDriver driver{scanner};

    flatsql::parser::Parser parser(driver);
    parser.parse();

    return driver.Finish();
}

}  // namespace parser
}  // namespace flatsql
