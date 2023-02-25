#include "flatsql/text/rope.h"
#include "gtest/gtest.h"

using namespace flatsql;

TEST(Rope, Empty) {
    Rope<128> rope;
}
