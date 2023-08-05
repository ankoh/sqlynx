#include <initializer_list>
#include <optional>

#include "flatsql/api.h"
#include "flatsql/parser/parse_context.h"
#include "flatsql/parser/scanner.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/script.h"
#include "gtest/gtest.h"

using namespace flatsql;

using Token = proto::ScannerTokenType;

namespace {

TEST(ParserTest, FindNodeAtOffset) {
    std::shared_ptr<ParsedScript> script;

    // Helper to parse a script
    auto parse = [&](std::string_view text) {
        rope::Rope buffer{128};
        buffer.Insert(0, text);
        auto [scanned, scannerStatus] = parser::Scanner::Scan(buffer);
        ASSERT_EQ(scannerStatus, proto::StatusCode::OK);
        auto [parsed, parserStatus] = parser::ParseContext::Parse(scanned);
        ASSERT_EQ(parserStatus, proto::StatusCode::OK);
        script = std::move(parsed);
    };
    /// Test if ast node matches
    auto test_node_at_offset = [&](size_t text_offset, proto::NodeType nodeType, sx::Location loc) {
        // XXX
    };

    parse("select 1");
    test_node_at_offset(7, proto::NodeType::LITERAL_INTEGER, sx::Location(7, 1));
}

}  // namespace
