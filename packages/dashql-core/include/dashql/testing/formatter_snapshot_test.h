#pragma once

#include <filesystem>
#include <optional>
#include <string>
#include <vector>

#include "dashql/formatter/formatter.h"
#include "gtest/gtest.h"

namespace dashql::testing {

/// One (config, expected output) pair for a formatter snapshot.
struct FormatterExpectation {
    buffers::formatting::FormattingConfigT config;
    std::string formatted;
};

/// Optional validation block for a dialect: run setup + each formatted output against a live DB.
struct FormatterValidation {
    /// SQL to execute before running the formatted outputs
    std::string setup;
};

/// Per-dialect expectations for a formatter snapshot.
struct DialectFormatterExpectations {
    /// The dialect name
    std::string dialect;
    /// Whether this dialect should be skipped
    bool skip = false;
    /// Expectations for this dialect
    std::vector<FormatterExpectation> expectations;
    /// Optional validation against a live database
    std::optional<FormatterValidation> validation;
};

struct FormatterSnapshotTest {
    /// Printer test name
    struct TestPrinter {
        std::string operator()(const ::testing::TestParamInfo<const FormatterSnapshotTest*>& info) const {
            return std::string{info.param->name};
        }
    };

    /// The snapshot name (one test per input)
    std::string name;
    /// The input SQL
    std::string input;
    /// Per-dialect expectations
    std::vector<DialectFormatterExpectations> dialects;

    /// Load tests from formatter snapshot directory
    static void LoadTests(const std::filesystem::path& project_root);
    /// Get tests for a snapshot file
    static std::vector<const FormatterSnapshotTest*> GetTests(std::string_view filename);
};

extern void operator<<(std::ostream& out, const FormatterSnapshotTest& p);

}  // namespace dashql::testing
