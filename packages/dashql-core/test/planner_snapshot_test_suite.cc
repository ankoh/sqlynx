#include "dashql/testing/planner_snapshot_test.h"
#include "gtest/gtest.h"

using namespace dashql::testing;

namespace {

struct PlannerSnapshotTestSuite : public ::testing::TestWithParam<const PlannerSnapshotTest*> {};

TEST_P(PlannerSnapshotTestSuite, Test) { GetParam()->Test(); }

INSTANTIATE_TEST_SUITE_P(Basic, PlannerSnapshotTestSuite,
                         ::testing::ValuesIn(PlannerSnapshotTest::GetTests("basic.yaml")),
                         PlannerSnapshotTest::TestPrinter());

}  // namespace
