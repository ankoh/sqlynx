// Differential test oracle for the Rust port of the script diff (see tools/oracle_ffi.cc).

#include <cstdlib>
#include <cstring>
#include <exception>
#include <sstream>
#include <string>
#include <string_view>

#include "dashql/parser/parser.h"
#include "dashql/parser/scanner.h"
#include "dashql/script.h"
#include "dashql/script_diff.h"
#include "dashql/text/rope.h"

using namespace dashql;

extern "C" {

/// The result of an oracle call, see tools/oracle_ffi.cc
struct DashQLOracleResult {
    uint32_t status;
    char* data;
    size_t length;
};

/// Diff two scripts and dump the ops, one per line:
///   <code> <source statement> <target statement> <source span> <target span> <change count> <changes...>
/// with u32 max for missing statements and spans as <offset> <length>.
DashQLOracleResult dashql_oracle_script_diff(const char* source, size_t source_length, const char* target,
                                             size_t target_length);
}

namespace {

DashQLOracleResult Result(uint32_t status, std::string_view out) {
    auto* data = static_cast<char*>(std::malloc(std::max<size_t>(out.size(), 1)));
    std::memcpy(data, out.data(), out.size());
    return DashQLOracleResult{.status = status, .data = data, .length = out.size()};
}

}  // namespace

DashQLOracleResult dashql_oracle_script_diff(const char* source, size_t source_length, const char* target,
                                             size_t target_length) {
    try {
        rope::Rope source_rope{1024, std::string_view{source, source_length}};
        auto source_parsed = parser::Parser::Parse(parser::Scanner::Scan(source_rope, 0, 1));
        rope::Rope target_rope{1024, std::string_view{target, target_length}};
        auto target_parsed = parser::Parser::Parse(parser::Scanner::Scan(target_rope, 0, 2));
        ScriptDiff diff{*source_parsed, *target_parsed};
        std::stringstream out;
        for (auto& op : diff.Compute()) {
            out << static_cast<int>(op.code) << " " << op.source_statement.value_or(UINT32_MAX) << " "
                << op.target_statement.value_or(UINT32_MAX) << " " << op.source_span.offset() << " "
                << op.source_span.length() << " " << op.target_span.offset() << " " << op.target_span.length() << " "
                << op.target_changes.size();
            for (auto& change : op.target_changes) {
                out << " " << change.offset() << " " << change.length();
            }
            out << "\n";
        }
        return Result(0, out.str());
    } catch (const std::exception& e) {
        return Result(1, e.what());
    } catch (...) {
        return Result(1, "unknown exception");
    }
}
