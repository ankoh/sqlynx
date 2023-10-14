#include "sqlynx/testing/xml_tests.h"

#include <sstream>

#include "sqlynx/script.h"

namespace sqlynx::testing {

constexpr size_t INLINE_LOCATION_CAP = 20;
constexpr size_t LOCATION_HINT_LENGTH = 10;

/// Matches the expected result?
::testing::AssertionResult Matches(const pugi::xml_node& have, const pugi::xml_node& expected) {
    std::stringstream expected_ss;
    std::stringstream actual_ss;
    expected.print(expected_ss);
    have.print(actual_ss);
    auto expected_str = expected_ss.str();
    auto actual_str = actual_ss.str();
    if (expected_str == actual_str) return ::testing::AssertionSuccess();

    std::stringstream err;

    err << std::endl;
    err << "HAVE" << std::endl;
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

void WriteLocation(pugi::xml_node n, proto::Location loc, std::string_view text) {
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

}  // namespace sqlynx::testing
