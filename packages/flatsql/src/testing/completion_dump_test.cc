#include "flatsql/testing/completion_dump_test.h"

#include <algorithm>
#include <fstream>
#include <limits>

#include "flatsql/analyzer/analyzer.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/script.h"
#include "flatsql/testing/xml_tests.h"
#include "gtest/gtest.h"

namespace flatsql {
namespace testing {

// The files
static std::unordered_map<std::string, std::vector<CompletionDumpTest>> TEST_FILES;

// Get the tests
std::vector<const CompletionDumpTest*> CompletionDumpTest::GetTests(std::string_view filename) {
    std::string name{filename};
    auto iter = TEST_FILES.find(name);
    if (iter == TEST_FILES.end()) {
        return {};
    }
    std::vector<const CompletionDumpTest*> tests;
    for (auto& test : iter->second) {
        tests.emplace_back(&test);
    }
    return tests;
}

/// Get the grammar tests
void CompletionDumpTest::LoadTests(std::filesystem::path& source_dir) {
    auto dumps_dir = source_dir / "dumps" / "completion";
    std::cout << "Loading completion tests at: " << dumps_dir << std::endl;

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
        auto root = doc.child("completion-dumps");

        // Read tests
        std::vector<CompletionDumpTest> tests;
        for (auto test : root.children()) {
            // Create test
            tests.emplace_back();
            auto& t = tests.back();
            auto xml_external = test.find_child_by_attribute("script", "context", "external");
            auto xml_main = test.find_child_by_attribute("script", "context", "main");
            t.name = test.attribute("name").as_string();
            t.input_external = xml_external.child("input").last_child().value();
            t.input_main = xml_main.child("input").last_child().value();

            // Read the cursor
            auto xml_cursor = test.child("cursor");
            auto xml_cursor_search = xml_cursor.child("search");
            t.cursor_search_index = xml_cursor_search.attribute("index").as_int();
            t.cursor_search_string = xml_cursor_search.value();

            // Read the expected completions
            auto completions = test.child("completions");
            t.completion_limit = completions.attribute("limit").as_int();
            t.completions.append_copy(completions);
        }

        std::cout << "[ SETUP    ] " << filename << ": " << tests.size() << " tests" << std::endl;

        // Register test
        TEST_FILES.insert({filename, std::move(tests)});
    }
}

}  // namespace testing
}  // namespace flatsql
