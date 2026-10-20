// Differential test oracle for the Rust rewrite (//packages/dashql-core-rs:dashql_oracle).
//
// Exposes the C++ core natively through a small C ABI that never throws. Every function
// returns its output in the same serialization the snapshot tests use, so the Rust port can
// be compared against the C++ core on arbitrary inputs, not only on the checked-in snapshots.

#include <cstdlib>
#include <cstring>
#include <exception>
#include <sstream>
#include <string>
#include <string_view>

#include "c4/yml/emit.hpp"
#include "c4/yml/std/std.hpp"
#include "dashql/exception.h"
#include "dashql/parser/parser.h"
#include "dashql/parser/scanner.h"
#include "dashql/script.h"
#include "dashql/testing/parser_snapshot_test.h"
#include "dashql/text/rope.h"
#include "ryml.hpp"

using namespace dashql;

extern "C" {

/// The result of an oracle call. `data` is owned by the oracle, release it with dashql_oracle_free.
struct DashQLOracleResult {
    /// 0 if the call succeeded, 1 if it failed (data then holds the error message)
    uint32_t status;
    /// The output bytes (not NUL-terminated)
    char* data;
    /// The output length
    size_t length;
};

/// Release an oracle result
void dashql_oracle_free(DashQLOracleResult result);
/// Scan a script and dump the symbols as lines of `<kind> <offset> <length>[ <name_id>]`
DashQLOracleResult dashql_oracle_scan(const char* text, size_t length);
/// Scan and parse a script, return the `expected` YAML of a parser snapshot
DashQLOracleResult dashql_oracle_parse(const char* text, size_t length);
}

namespace {

DashQLOracleResult Ok(std::string_view out) {
    auto* data = static_cast<char*>(std::malloc(std::max<size_t>(out.size(), 1)));
    std::memcpy(data, out.data(), out.size());
    return DashQLOracleResult{.status = 0, .data = data, .length = out.size()};
}

DashQLOracleResult Err(std::string_view message) {
    auto result = Ok(message);
    result.status = 1;
    return result;
}

template <typename F> DashQLOracleResult Guard(F fn) {
    try {
        return Ok(fn());
    } catch (const dashql::Exception& e) {
        return Err(std::string{buffers::status::EnumNameStatusCode(e.GetCode())} + ": " + e.what());
    } catch (const std::exception& e) {
        return Err(e.what());
    } catch (...) {
        return Err("unknown exception");
    }
}

}  // namespace

void dashql_oracle_free(DashQLOracleResult result) { std::free(result.data); }

DashQLOracleResult dashql_oracle_scan(const char* text, size_t length) {
    return Guard([&]() {
        rope::Rope input{1024, std::string_view{text, length}};
        auto scanned = parser::Scanner::Scan(input, 0, 2);
        std::stringstream out;
        scanned->symbols.ForEach([&](size_t, const parser::Parser::symbol_type& symbol) {
            out << static_cast<int>(symbol.kind()) << " " << symbol.location.offset() << " "
                << symbol.location.length();
            if (symbol.kind() == parser::Parser::symbol_kind_type::S_IDENT) {
                out << " " << symbol.value.as<size_t>();
            }
            out << "\n";
        });
        return out.str();
    });
}

DashQLOracleResult dashql_oracle_parse(const char* text, size_t length) {
    return Guard([&]() {
        std::string input{text, length};
        rope::Rope input_rope{1024, input};
        auto scanned = parser::Scanner::Scan(input_rope, 0, 2);
        auto parsed = parser::Parser::Parse(scanned);

        c4::yml::Tree out_tree;
        auto out_root = out_tree.rootref();
        out_root.set_type(c4::yml::MAP);
        dashql::testing::ParserSnapshotTest::EncodeScript(out_root, *scanned, *parsed, input);
        // The emitter recurses once per container, deep ASTs (e.g. tpcds) need a raised limit.
        return c4::yml::emitrs_yaml<std::string>(out_tree.rootref(), c4::yml::EmitOptions().max_depth(256));
    });
}
