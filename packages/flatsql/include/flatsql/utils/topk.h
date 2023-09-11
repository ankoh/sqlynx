#pragma once

#include <cstddef>
#include <functional>

namespace flatsql {

template <typename ValueType, typename ScoreType> struct TopKHeap {
   public:
    /// An entry
    struct Entry {
        /// The heap value
        ValueType value;
        /// The heap score
        ScoreType score;
        /// Constructor
        Entry(ValueType value, ScoreType score) : value(value), score(score) {}
    };

   protected:
    /// The min-heap entries
    std::vector<Entry> entries;

   public:
    /// Constructor
    TopKHeap(size_t capacity) { entries.reserve(capacity); }
    /// Get the entries
    auto& GetEntries() const { return entries; }
    /// Helper to move the last element up the heap
    void FixHeap() {
        size_t i = 0;
        while (true) {
            size_t li = 2 * i + 1;
            size_t ri = 2 * i + 2;
            size_t best = i;
            if (li < entries.size() && entries[li].score < entries[best].score) {
                best = li;
            }
            if (ri < entries.size() && entries[ri].score < entries[best].score) {
                best = ri;
            }
            if (best == i) {
                break;
            }
            std::swap(entries[i], entries[best]);
            i = best;
        }
    }
    /// Insert an entry
    void Insert(ValueType value, ScoreType score) {
        assert(entries.capacity() > 0);
        // Check if the heap has space
        if (entries.size() < entries.capacity()) {
            entries.push_back(Entry{value, score});
            if (entries.size() == entries.capacity()) {
                std::sort(entries.begin(), entries.end(), [](Entry& l, Entry& r) { return l.score < r.score; });
            }
        } else {
            auto& min = entries.front();
            if (min.score < score) {
                min.score = score;
                min.value = value;
                FixHeap();
            }
        }
    }
};

}  // namespace flatsql
