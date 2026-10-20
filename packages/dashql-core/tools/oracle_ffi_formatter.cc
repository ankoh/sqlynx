// Formatter functions of the differential test oracle (see tools/oracle_ffi.cc).

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <string>
#include <string_view>

#include "dashql/exception.h"
#include "dashql/formatter/formatter.h"
#include "dashql/parser/parser.h"
#include "dashql/parser/scanner.h"
#include "dashql/script.h"
#include "dashql/text/rope.h"

using namespace dashql;

extern "C" {

/// The result of an oracle call, declared in tools/oracle_ffi.cc
struct DashQLOracleResult {
    uint32_t status;
    char* data;
    size_t length;
};

/// A formatting config (buffers::formatting::FormattingConfigT)
struct DashQLOracleFormattingConfig {
    uint8_t dialect;
    uint8_t mode;
    uint8_t keyword_case;
    uint8_t debug_mode;
    uint32_t max_width;
    uint32_t indentation_width;
};

/// Scan, parse and format a script (`Formatter::Format`). The output is
///   U <node id> <node id> ...      the unformattable nodes, in order
/// followed by the formatted script.
DashQLOracleResult dashql_oracle_format(const char* text, size_t length, const DashQLOracleFormattingConfig* config);
/// Scan and parse a script and format a single node with executable literals (`Formatter::FormatNodeAt` after
/// `ReplaceObfuscatedLiterals`, as the script compiler does). The output has the format of dashql_oracle_format.
DashQLOracleResult dashql_oracle_format_node(const char* text, size_t length, uint32_t node_id,
                                             const DashQLOracleFormattingConfig* config);
}

namespace {

DashQLOracleResult FormatterOk(std::string_view out) {
    auto* data = static_cast<char*>(std::malloc(std::max<size_t>(out.size(), 1)));
    std::memcpy(data, out.data(), out.size());
    return DashQLOracleResult{.status = 0, .data = data, .length = out.size()};
}

DashQLOracleResult FormatterErr(std::string_view message) {
    auto result = FormatterOk(message);
    result.status = 1;
    return result;
}

template <typename F> DashQLOracleResult FormatterGuard(F fn) {
    try {
        return FormatterOk(fn());
    } catch (const dashql::Exception& e) {
        return FormatterErr(std::string{buffers::status::EnumNameStatusCode(e.GetCode())} + ": " + e.what());
    } catch (const std::exception& e) {
        return FormatterErr(e.what());
    } catch (...) {
        return FormatterErr("unknown exception");
    }
}

buffers::formatting::FormattingConfigT ReadConfig(const DashQLOracleFormattingConfig& in) {
    buffers::formatting::FormattingConfigT config;
    config.dialect = static_cast<buffers::formatting::FormattingDialect>(in.dialect);
    config.mode = static_cast<buffers::formatting::FormattingMode>(in.mode);
    config.keyword_case = static_cast<buffers::formatting::KeywordCase>(in.keyword_case);
    config.debug_mode = in.debug_mode != 0;
    config.max_width = in.max_width;
    config.indentation_width = in.indentation_width;
    return config;
}

std::string WriteOutput(const Formatter& formatter, std::string_view formatted) {
    std::string out = "U";
    for (auto node_id : formatter.GetUnformattableNodes()) {
        out += " ";
        out += std::to_string(node_id);
    }
    out += "\n";
    out += formatted;
    return out;
}

}  // namespace

DashQLOracleResult dashql_oracle_format(const char* text, size_t length, const DashQLOracleFormattingConfig* config) {
    return FormatterGuard([&]() {
        rope::Rope input{1024, std::string_view{text, length}};
        auto scanned = parser::Scanner::Scan(input, 0, 2);
        auto parsed = parser::Parser::Parse(scanned);
        Formatter formatter{*parsed};
        auto formatted = formatter.Format(ReadConfig(*config));
        return WriteOutput(formatter, formatted);
    });
}

DashQLOracleResult dashql_oracle_format_node(const char* text, size_t length, uint32_t node_id,
                                             const DashQLOracleFormattingConfig* config) {
    return FormatterGuard([&]() {
        rope::Rope input{1024, std::string_view{text, length}};
        auto scanned = parser::Scanner::Scan(input, 0, 2);
        auto parsed = parser::Parser::Parse(scanned);
        Formatter formatter{*parsed};
        formatter.ReplaceObfuscatedLiterals();
        auto formatted = formatter.FormatNodeAt(node_id, ReadConfig(*config));
        return WriteOutput(formatter, formatted);
    });
}
