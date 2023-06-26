#include "flatsql/testing/parser_dump_test.h"

#include <cstdint>
#include <fstream>
#include <iostream>
#include <regex>
#include <sstream>
#include <stack>
#include <unordered_set>

#include "flatsql/parser/grammar/enums.h"
#include "flatsql/proto/proto_generated.h"
#include "pugixml.hpp"

namespace flatsql::testing {

/// Encode yaml
void ParserDumpTest::EncodeScript(pugi::xml_node root, const ScannedScript& scanned, const ParsedScript& parsed,
                                  std::string_view text) {
    // Unpack modules
    auto& nodes = parsed.nodes;
    auto& statements = parsed.statements;
    auto* stmt_type_tt = proto::StatementTypeTypeTable();
    auto* node_type_tt = proto::NodeTypeTypeTable();

    // Add the statements list
    auto stmts = root.append_child("statements");

    // Translate the statement tree with a DFS
    for (unsigned stmt_id = 0; stmt_id < statements.size(); ++stmt_id) {
        auto& s = statements[stmt_id];

        auto stmt = stmts.append_child("statement");
        stmt.append_attribute("type") = stmt_type_tt->names[static_cast<uint16_t>(s.type)];

        std::vector<std::tuple<pugi::xml_node, const proto::Node*>> pending;
        pending.push_back({stmt.append_child("node"), &nodes[s.root]});

        while (!pending.empty()) {
            auto [n, target] = pending.back();
            pending.pop_back();

            // Add or append to parent
            if (target->attribute_key() != proto::AttributeKey::NONE) {
                auto name = proto::EnumNameAttributeKey(target->attribute_key());
                n.append_attribute("key").set_value(name);
            }

            // Check node type
            n.append_attribute("type").set_value(
                proto::NodeTypeTypeTable()->names[static_cast<uint16_t>(target->node_type())]);
            switch (target->node_type()) {
                case proto::NodeType::NONE:
                    break;
                case proto::NodeType::BOOL: {
                    n.append_attribute("value") = target->children_begin_or_value() != 0;
                    break;
                }
                case proto::NodeType::OPERATOR:
                case proto::NodeType::NAME:
                case proto::NodeType::LITERAL_NULL:
                case proto::NodeType::LITERAL_FLOAT:
                case proto::NodeType::LITERAL_INTEGER:
                case proto::NodeType::LITERAL_INTERVAL:
                case proto::NodeType::LITERAL_STRING: {
                    EncodeLocation(n, target->location(), text);
                    break;
                }
                case proto::NodeType::ARRAY: {
                    EncodeLocation(n, target->location(), text);
                    auto begin = target->children_begin_or_value();
                    auto end = begin + target->children_count();
                    for (auto i = 0; i < target->children_count(); ++i) {
                        pending.push_back({n.append_child("node"), &nodes[begin + i]});
                    }
                    break;
                }
                default: {
                    auto node_type_id = static_cast<uint32_t>(target->node_type());
                    if (node_type_id > static_cast<uint32_t>(proto::NodeType::OBJECT_KEYS_)) {
                        EncodeLocation(n, target->location(), text);
                        auto begin = target->children_begin_or_value();
                        for (auto i = 0; i < target->children_count(); ++i) {
                            pending.push_back({n.append_child("node"), &nodes[begin + i]});
                        }
                    } else if (node_type_id > static_cast<uint32_t>(proto::NodeType::ENUM_KEYS_)) {
                        n.append_attribute("value") = flatsql::parser::getEnumText(*target);
                    } else {
                        n.append_attribute("value") = target->children_begin_or_value();
                    }
                    break;
                }
            }
        }
    }

    // Add scanner errors
    auto parser_errors = root.append_child("scanner-errors");
    for (auto& [err_loc, err_msg] : scanned.errors) {
        auto error = parser_errors.append_child("error");
        error.append_attribute("message") = err_msg.c_str();
        EncodeLocation(error, err_loc, text);
    }

    // Add parser errors
    auto scanner_errors = root.append_child("parser-errors");
    for (auto& [err_loc, err_msg] : parsed.errors) {
        auto error = scanner_errors.append_child("error");
        error.append_attribute("message") = err_msg.c_str();
        EncodeLocation(error, err_loc, text);
    }

    // Add line breaks
    auto line_breaks = root.append_child("line-breaks");
    for (auto& lb : scanned.line_breaks) {
        auto lb_node = line_breaks.append_child("line-break");
        EncodeLocation(lb_node, lb, text);
    }

    // Add comments
    auto comments = root.append_child("comments");
    for (auto& comment : scanned.comments) {
        auto comment_node = comments.append_child("comment");
        EncodeLocation(comment_node, comment, text);
    }
}

// The files
static std::unordered_map<std::string, std::vector<ParserDumpTest>> TEST_FILES;

// Load the tests
void ParserDumpTest::LoadTests(std::filesystem::path& source_dir) {
    auto dumps_dir = source_dir / "dumps" / "parser";
    std::cout << "Loading grammar tests at: " << dumps_dir << std::endl;

    for (auto& p : std::filesystem::directory_iterator(dumps_dir)) {
        auto filename = p.path().filename().string();
        if (p.path().extension().string() != ".xml") continue;

        // Make sure that it's no template
        auto tpl = p.path();
        tpl.replace_extension();
        if (tpl.extension() == ".tpl") continue;

        // Open input stream
        std::ifstream in(p.path(), std::ios::in | std::ios::binary);
        if (!in) {
            std::cout << "[ SETUP    ] failed to read test file: " << filename << std::endl;
            continue;
        }

        // Parse xml document
        pugi::xml_document doc;
        doc.load(in);
        auto root = doc.child("parser-dumps");

        // Read tests
        std::vector<ParserDumpTest> tests;
        for (auto test : root.children()) {
            // Create test
            tests.emplace_back();
            auto& t = tests.back();
            t.name = test.attribute("name").as_string();
            t.input = test.child("input").last_child().value();

            pugi::xml_document expected;
            for (auto s : test.child("expected").children()) {
                expected.append_copy(s);
            }
            t.expected = std::move(expected);
        }

        std::cout << "[ SETUP    ] " << filename << ": " << tests.size() << " tests" << std::endl;

        // Register test
        TEST_FILES.insert({filename, std::move(tests)});
    }
}

// Get the tests
std::vector<const ParserDumpTest*> ParserDumpTest::GetTests(std::string_view filename) {
    std::string name{filename};
    auto iter = TEST_FILES.find(name);
    if (iter == TEST_FILES.end()) {
        return {};
    }
    std::vector<const ParserDumpTest*> tests;
    for (auto& test : iter->second) {
        tests.emplace_back(&test);
    }
    return tests;
}

}  // namespace flatsql::testing
