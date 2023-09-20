#pragma once

#include <filesystem>
#include <string>
#include <unordered_map>

#include "flatsql/analyzer/completion.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/script.h"
#include "gtest/gtest.h"
#include "pugixml.hpp"

namespace flatsql::testing {

struct CompletionSnapshotTest {
    /// Printer test name
    struct TestPrinter {
        std::string operator()(const ::testing::TestParamInfo<const CompletionSnapshotTest*>& info) const {
            return std::string{info.param->name};
        }
    };

    /// The name
    std::string name;
    /// The schema
    std::string input_external;
    /// The script
    std::string input_main;
    /// The cursor context
    std::string cursor_context;
    /// The search string for the cursor
    std::string cursor_search_string;
    /// The search index for the cursor
    size_t cursor_search_index;
    /// The completion limit
    size_t completion_limit;
    /// The completions
    pugi::xml_document completions;

    /// Encode a script
    static void EncodeScript(pugi::xml_node root, const Completion& completion);
    /// Get the grammar tests
    static void LoadTests(std::filesystem::path& project_root);
    /// Get the grammar tests
    static std::vector<const CompletionSnapshotTest*> GetTests(std::string_view filename);
};

extern void operator<<(std::ostream& out, const CompletionSnapshotTest& p);

}  // namespace flatsql::testing
