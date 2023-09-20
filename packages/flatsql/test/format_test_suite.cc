#include <exception>
#include <filesystem>
#include <fstream>
#include <optional>
#include <stdexcept>
#include <string_view>

#include "flatsql/analyzer/completion.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/script.h"
#include "gtest/gtest.h"
#include "pugixml.hpp"

using namespace flatsql;

extern std::filesystem::path source_dir;
extern bool update_expecteds;

namespace {

struct TestCase {
    /// The (optional) comment at the beginning of the file
    std::string comment;
    /// The input
    std::string input;
    /// The expected output
    std::string expectedOutput;

    /// Parse from a string
    static TestCase parse(std::string_view str);

    /// Format as a string
    std::string format() const;
};

TestCase TestCase::parse(std::string_view str) {
    TestCase result;
    const char* iter = str.begin();
    const char* limit = str.end();

    auto getNextLine = [&]() -> std::optional<std::string_view> {
        if (iter == limit) {
            return std::nullopt;
        }
        const char* lineBegin = iter;
        while (iter != limit && *iter != '\n') {
            ++iter;
        }
        const char* lineEnd = iter;
        if (iter != limit) {
            ++iter;
        }
        return std::string_view{lineBegin, lineEnd};
    };
    std::optional<std::string_view> currentLine = getNextLine();

    // Skip empty lines
    while (currentLine && currentLine->empty()) {
        currentLine = getNextLine();
    }

    // Parse lines starting with '#' as comments
    while (currentLine && currentLine->starts_with("#")) {
        result.comment += currentLine->substr(1);
        result.comment += "\n";
        currentLine = getNextLine();
    }

    // Skip empty lines
    while (currentLine && currentLine->empty()) {
        currentLine = getNextLine();
    }

    // Parse everything until a `----` line as input
    while (currentLine && currentLine != "----") {
        if (currentLine->starts_with("#")) {
            throw std::runtime_error("Comments are only supported at the beginning of the file");
        }
        if (!result.input.empty()) {
            result.input += "\n";
        }
        result.input += *currentLine;
        currentLine = getNextLine();
    }

    // Ignore the `----` line
    currentLine = getNextLine();

    // Everything after the `----` line is the expected output
    while (currentLine && currentLine != "----") {
        if (!result.expectedOutput.empty()) {
            result.expectedOutput += "\n";
        }
        result.expectedOutput += *currentLine;
        currentLine = getNextLine();
    }

    // Make sure we reached the end of the file
    if (currentLine) {
        throw std::runtime_error("Unexpected second `----` line");
    }

    return result;
}

std::string TestCase::format() const {
    std::string result;

    // Print the comment
    bool newCommentLine = true;
    for (char c : comment) {
        if (newCommentLine) {
            result += "#";
        }
        result += c;
        newCommentLine = c == '\n';
    }

    // Empty line between comment and input
    if (!comment.empty()) {
        result += '\n';
    }

    // Input and expected output
    result += input;
    result += "\n----\n";
    result += expectedOutput;
    result += "\n";

    return result;
}

std::string readFile(std::filesystem::path p) {
    std::ifstream in(p, std::ios::binary);
    std::stringstream buffer;
    buffer << in.rdbuf();
    return buffer.str();
}

struct FormatTestSuite : public ::testing::TestWithParam<std::filesystem::path> {};

void operator<<(std::ostream& out, const std::filesystem::path& p) { out << p; }

TEST_P(FormatTestSuite, Test) {
    std::filesystem::path filePath = source_dir / "snapshots" / "format" / GetParam();
    std::string fileContent = readFile(filePath);
    TestCase test = TestCase::parse(fileContent);

    Script s;
    s.InsertTextAt(0, test.input);
    ASSERT_EQ(s.Scan().second, proto::StatusCode::OK);
    ASSERT_EQ(s.Parse().second, proto::StatusCode::OK);
    std::string actual = s.Format();

    if (update_expecteds) {
        std::ofstream out(filePath, std::ios::binary);
        test.expectedOutput = actual;
        std::string formatted = test.format();
        out.write(formatted.data(), formatted.size());
    } else {
        ASSERT_EQ(actual, test.expectedOutput);
    }
}

std::vector<std::filesystem::path> listTestFiles(std::filesystem::path p) {
    using namespace std::filesystem;
    std::vector<std::filesystem::path> paths;
    for (const directory_entry& dir_entry : recursive_directory_iterator(p)) {
        if (dir_entry.is_regular_file() && dir_entry.path().extension() == ".test") {
            paths.push_back(relative(dir_entry.path(), p));
        }
    }
    return paths;
}

auto printFilePathTestName = [](const ::testing::TestParamInfo<std::filesystem::path>& info) {
    std::filesystem::path p = info.param;
    // Strip the file extensions
    auto str = (p.parent_path() / p.stem()).string();
    // Replace `/` by `_`
    std::replace(str.begin(), str.end(), '/', '_');
    return str;
};

// clang-format off
INSTANTIATE_TEST_SUITE_P(Format, FormatTestSuite, ::testing::ValuesIn(listTestFiles(source_dir / "snapshots" / "format")), printFilePathTestName);

} // namespace
