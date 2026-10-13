#pragma once

#include <filesystem>
#include <string>
#include <string_view>
#include <vector>

#include "gtest/gtest.h"
#include "ryml.hpp"

namespace dashql::testing {

struct PlannerSnapshotTest {
    struct TestPrinter {
        std::string operator()(const ::testing::TestParamInfo<const PlannerSnapshotTest*>& info) const {
            return info.param->name;
        }
    };

    std::string name;
    c4::yml::Tree* tree = nullptr;
    c4::yml::id_type node_id = c4::yml::NONE;

    /// Prepare the fixture scripts, build the native graph, and encode its readable snapshot.
    static void Encode(c4::yml::NodeRef out, c4::yml::ConstNodeRef fixture);
    void Test() const;
    static void LoadTests(const std::filesystem::path& snapshots_dir);
    static std::vector<const PlannerSnapshotTest*> GetTests(std::string_view filename);
};

}  // namespace dashql::testing
