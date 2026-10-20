#include "dashql/testing/formatter_snapshot_test.h"

#include <fstream>
#include <iostream>
#include <sstream>

#include "c4/yml/std/std.hpp"
#include "dashql/formatter/formatting_program.h"
#include "dashql/testing/runfiles_dir.h"
#include "dashql/testing/yaml_tests.h"
#include "dashql/utils/string_trimming.h"
#include "ryml.hpp"

namespace dashql::testing {

void operator<<(std::ostream& out, const FormatterSnapshotTest& p) { out << p.name; }

// The files
static std::unordered_map<std::string, std::vector<FormatterSnapshotTest>> TEST_FILES;

// Load the tests
void FormatterSnapshotTest::LoadTests(const std::filesystem::path& snapshots_dir) {
    if (!TEST_FILES.empty()) return;
    std::cout << "Loading formatting tests at: " << snapshots_dir << std::endl;

    for (auto& p : std::filesystem::directory_iterator(snapshots_dir)) {
        auto filename = p.path().filename().string();
        if (p.path().extension().string() != ".yaml") continue;

        // Skip template outputs (e.g. basic.tpl.yaml)
        if (filename.find(".tpl.") != std::string::npos) continue;

        std::ifstream in(p.path(), std::ios::in | std::ios::binary);
        if (!in) {
            std::cout << "[ SETUP    ] failed to read test file: " << filename << std::endl;
            continue;
        }

        std::stringstream buf;
        buf << in.rdbuf();
        std::string content = buf.str();

        c4::yml::Tree tree;
        c4::yml::parse_in_arena(c4::to_csubstr(content), &tree);

        auto root = tree.rootref();
        if (!root.has_child("formatter-snapshots")) {
            std::cout << "[ SETUP    ] " << filename << ": no formatter-snapshots key" << std::endl;
            continue;
        }

        std::vector<FormatterSnapshotTest> tests;
        auto snapshots = root["formatter-snapshots"];
        for (auto snapshot : snapshots.children()) {
            FormatterSnapshotTest t;
            if (snapshot.has_child("name")) {
                c4::csubstr v = snapshot["name"].val();
                t.name = v.str ? std::string(v.str, v.len) : std::string();
            }
            if (snapshot.has_child("input")) {
                c4::csubstr v = snapshot["input"].val();
                if (v.str) {
                    std::string_view trimmed = trim_view(std::string_view{v.str, v.len}, is_no_space);
                    t.input.assign(trimmed.data(), trimmed.size());
                }
            }
            if (snapshot.has_child("dialects")) {
                for (auto dialect_node : snapshot["dialects"].children()) {
                    DialectFormatterExpectations dialect_exp;
                    c4::csubstr dialect_key = dialect_node.key();
                    dialect_exp.dialect =
                        dialect_key.str ? std::string(dialect_key.str, dialect_key.len) : std::string();
                    buffers::formatting::FormattingDialect parsed_dialect = ParseFormattingDialect(dialect_exp.dialect);
                    if (dialect_node.is_map() && dialect_node.has_child("skip")) {
                        c4::csubstr v = dialect_node["skip"].val();
                        dialect_exp.skip = (v == "true" || v == "1");
                    }
                    if (dialect_node.has_child("formatted")) {
                        for (auto formatted_node : dialect_node["formatted"].children()) {
                            FormatterExpectation exp;
                            exp.config.dialect = parsed_dialect;
                            exp.config.mode = ParseFormattingMode(
                                formatted_node.has_child("mode")
                                    ? std::string(formatted_node["mode"].val().str, formatted_node["mode"].val().len)
                                    : std::string("compact"));
                            exp.config.indentation_width =
                                formatted_node.has_child("indent")
                                    ? static_cast<size_t>(std::atoi(formatted_node["indent"].val().str))
                                    : FORMATTING_DEFAULT_INDENTATION_WIDTH;
                            exp.config.max_width =
                                formatted_node.has_child("width")
                                    ? static_cast<size_t>(std::atoi(formatted_node["width"].val().str))
                                    : FORMATTING_DEFAULT_MAX_WIDTH;
                            if (formatted_node.has_child("expected")) {
                                c4::csubstr v = formatted_node["expected"].val();
                                if (v.str) {
                                    std::string_view trimmed = trim_view(std::string_view{v.str, v.len}, is_no_space);
                                    exp.formatted.assign(trimmed.data(), trimmed.size());
                                }
                            }
                            dialect_exp.expectations.push_back(std::move(exp));
                        }
                    }
                    if (dialect_node.has_child("validation")) {
                        auto val_node = dialect_node["validation"];
                        FormatterValidation v;
                        if (val_node.is_map() && val_node.has_child("setup")) {
                            c4::csubstr s = val_node["setup"].val();
                            if (s.str) {
                                std::string_view trimmed = trim_view(std::string_view{s.str, s.len}, is_no_space);
                                v.setup.assign(trimmed.data(), trimmed.size());
                            }
                        }
                        dialect_exp.validation = std::move(v);
                    }
                    if (dialect_exp.skip || !dialect_exp.expectations.empty()) {
                        t.dialects.push_back(std::move(dialect_exp));
                    }
                }
            }
            if (!t.dialects.empty()) {
                tests.push_back(std::move(t));
            }
        }

        std::cout << "[ SETUP    ] " << filename << ": " << tests.size() << " tests" << std::endl;
        TEST_FILES.insert({filename, std::move(tests)});
    }
}

// Get the tests
std::vector<const FormatterSnapshotTest*> FormatterSnapshotTest::GetTests(std::string_view filename) {
    if (TEST_FILES.empty()) {
        auto root = GetRunfilesSnapshotRoot();
        LoadTests((root.empty() ? std::filesystem::path(".") : root) / "snapshots" / "formatter");
    }
    std::string name{filename};
    auto iter = TEST_FILES.find(name);
    if (iter == TEST_FILES.end()) {
        return {};
    }
    std::vector<const FormatterSnapshotTest*> tests;
    for (auto& test : iter->second) {
        tests.emplace_back(&test);
    }
    return tests;
}

}  // namespace dashql::testing
