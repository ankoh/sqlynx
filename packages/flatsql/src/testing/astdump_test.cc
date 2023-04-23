#include "flatsql/testing/astdump_test.h"

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

constexpr size_t INLINE_LOCATION_CAP = 20;
constexpr size_t LOCATION_HINT_LENGTH = 10;

void EncodeLocation(pugi::xml_node n, proto::Location loc, std::string_view text) {
    auto begin = loc.offset();
    auto end = loc.offset() + loc.length();
    {
        std::stringstream ss;
        ss << begin << ".." << end;
        n.append_attribute("loc") = ss.str().c_str();
    }
    {
        std::stringstream ss;
        if (loc.length() < INLINE_LOCATION_CAP) {
            ss << text.substr(loc.offset(), loc.length());
        } else {
            auto prefix = text.substr(loc.offset(), LOCATION_HINT_LENGTH);
            auto suffix = text.substr(loc.offset() + loc.length() - LOCATION_HINT_LENGTH, LOCATION_HINT_LENGTH);
            ss << prefix << ".." << suffix;
        }
        n.append_attribute("text") = ss.str().c_str();
    }
}

void EncodeError(pugi::xml_node n, const proto::ErrorT& err, std::string_view text) {
    n.append_attribute("message") = err.message.c_str();
    EncodeLocation(n, *err.location, text);
}

/// Encode yaml
void ASTDumpTest::EncodeProgram(pugi::xml_node root, const proto::ProgramT& program, std::string_view text) {
    // Unpack modules
    auto& nodes = program.nodes;
    auto& statements = program.statements;
    auto* stmt_type_tt = proto::StatementTypeTypeTable();
    auto* node_type_tt = proto::NodeTypeTypeTable();

    // Add the statements list
    auto stmts = root.append_child("statements");

    // Translate the statement tree with a DFS
    for (unsigned stmt_id = 0; stmt_id < statements.size(); ++stmt_id) {
        auto& s = *statements[stmt_id];

        auto stmt = stmts.append_child("statement");
        stmt.append_attribute("type") = stmt_type_tt->names[static_cast<uint16_t>(s.statement_type)];

        std::vector<std::tuple<pugi::xml_node, const proto::Node*>> pending;
        pending.push_back({stmt.append_child("node"), &nodes[s.root_node]});

        while (!pending.empty()) {
            auto [n, target] = pending.back();
            pending.pop_back();

            // Add or append to parent
            if (target->attribute_key() != 0) {
                auto name = proto::AttributeKeyTypeTable()->names[target->attribute_key()];
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
                case proto::NodeType::IDENTIFIER:
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

    // Add errors
    auto errors = root.append_child("errors");
    for (auto& err : program.errors) {
        auto error = errors.append_child("error");
        EncodeError(error, *err, text);
    }

    // Add line breaks
    auto line_breaks = root.append_child("line_breaks");
    for (auto& lb : program.line_breaks) {
        auto lb_node = line_breaks.append_child("line_break");
        EncodeLocation(lb_node, lb, text);
    }

    // Add comments
    auto comments = root.append_child("comments");
    for (auto& comment : program.comments) {
        auto comment_node = comments.append_child("comment");
        EncodeLocation(comment_node, comment, text);
    }
}

/// Matches the expected result?
::testing::AssertionResult ASTDumpTest::Matches(const pugi::xml_node& actual) const {
    std::stringstream expected_ss;
    std::stringstream actual_ss;
    expected.print(expected_ss);
    actual.print(actual_ss);
    auto expected_str = expected_ss.str();
    auto actual_str = actual_ss.str();
    if (expected_str == actual_str) return ::testing::AssertionSuccess();

    std::stringstream err;

    err << std::endl;
    err << "OUTPUT" << std::endl;
    err << "----------------------------------------" << std::endl;
    err << actual_str << std::endl;

    err << "EXPECTED" << std::endl;
    err << "----------------------------------------" << std::endl;
    std::vector<std::string> expected_lines, actual_lines;
    ::testing::internal::SplitString(expected_str, '\n', &expected_lines);
    ::testing::internal::SplitString(actual_str, '\n', &actual_lines);
    err << ::testing::internal::edit_distance::CreateUnifiedDiff(actual_lines, expected_lines);
    err << std::endl;

    return ::testing::AssertionFailure() << err.str();
}

// The files
static std::unordered_map<std::string, std::vector<ASTDumpTest>> TEST_FILES;

// Load the tests
void ASTDumpTest::LoadTests(std::filesystem::path& source_dir) {
    auto dumps_dir = source_dir / "dumps";

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
        auto root = doc.child("astdumps");

        // Read tests
        std::vector<ASTDumpTest> tests;
        for (auto test : root.children()) {
            // Create test
            tests.emplace_back();
            auto& t = tests.back();
            t.name = test.attribute("name").as_string();
            t.input = test.child("input").last_child().value();
            t.input.push_back(0);
            t.input.push_back(0);

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
std::vector<const ASTDumpTest*> ASTDumpTest::GetTests(std::string_view filename) {
    std::string name{filename};
    auto iter = TEST_FILES.find(name);
    if (iter == TEST_FILES.end()) {
        return {};
    }
    std::vector<const ASTDumpTest*> tests;
    for (auto& test : iter->second) {
        tests.emplace_back(&test);
    }
    return tests;
}

}  // namespace flatsql::test
