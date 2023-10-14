#include <unordered_map>
#include <vector>

namespace sqlynx {

template <typename ValueType, typename KeyType>
concept HasGetKeyFunction = requires(ValueType t) {
                                { t.GetKey() } -> std::same_as<KeyType>;
                            };
template <typename ValueType>
concept IsComparable = requires(const ValueType& l, const ValueType& r) {
                           { l < r } -> std::same_as<bool>;
                       };

enum class BinaryHeapType { MinHeap, MaxHeap };

template <typename ValueType, typename KeyType, typename KeyHasher, BinaryHeapType heap_type>
    requires HasGetKeyFunction<ValueType, KeyType> && IsComparable<ValueType>
struct IndexedBinaryHeap {
    /// The entries
    std::vector<ValueType> entries;
    /// The current positions
    std::unordered_map<KeyType, size_t, KeyHasher> entry_positions;

    /// Helper to swap two entries
    void Swap(size_t i, size_t j) {
        assert(i < entries.size());
        assert(j < entries.size());
        KeyType key_i = entries[i].GetKey();
        KeyType key_j = entries[j].GetKey();
        std::swap(entries[i], entries[j]);
        entry_positions.insert({key_i, j});
        entry_positions.insert({key_j, i});
    }

   public:
    /// Constructor
    IndexedBinaryHeap() = default;
    /// Constructor
    IndexedBinaryHeap(std::vector<ValueType> input) : entries(std::move(input)) {
        std::sort(entries.begin(), entries.end(), [&](auto& l, auto& r) { return OrderedBefore(l, r); });
        entry_positions.reserve(entries.size());
        for (ValueType& entry : entries) {
            auto key = entry.GetKey();
            entry_positions.insert({key, entry_positions.size()});
        }
    }
    /// Heap is empty?
    bool IsEmpty() const { return entries.empty(); }
    /// Clear the heap
    void Clear() {
        entries.clear();
        entry_positions.clear();
    }
    /// Helper to compare two values with respect to the heap type
    constexpr bool OrderedBefore(ValueType& l, ValueType& r) {
        if constexpr (heap_type == BinaryHeapType::MinHeap) {
            return l < r;
        } else {
            return r < l;
        }
    }
    /// Push an element downwards
    void PushDown(size_t i = 0) {
        assert(i < entries.size());
        while (true) {
            size_t li = 2 * i + 1;
            size_t ri = 2 * i + 2;
            size_t best = i;
            if (li < entries.size() && OrderedBefore(entries[li], entries[best])) {
                best = li;
            }
            if (ri < entries.size() && OrderedBefore(entries[ri], entries[best])) {
                best = ri;
            }
            if (best == i) {
                break;
            }
            Swap(i, best);
            i = best;
        }
    }
    /// Push an element downwards
    void PushDown(const ValueType* value) { PushDown(value - entries.data()); }
    /// Pull an element upwards
    void PullUp(size_t i = 0) {
        assert(i < entries.size());
        while (i != 0) {
            size_t parent = i / 2;
            if (OrderedBefore(entries[parent], entries[i])) {
                return;
            }
            Swap(i, parent);
            i = parent;
        }
    }
    /// Pull an element upwards
    void PullUp(const ValueType* value) { PullUp(value - entries.data()); }
    // Pop an element from the heap
    std::optional<ValueType> Pop() {
        if (entries.empty()) {
            return std::nullopt;
        } else if (entries.size() == 1) {
            ValueType value = entries.back();
            entries.pop_back();
            entry_positions.erase(value.GetKey());
            return {value};
        } else {
            Swap(0, entries.size() - 1);
            ValueType value = entries.back();
            entries.pop_back();
            PushDown();
            entry_positions.erase(value.GetKey());
            return {value};
        }
    }
    /// Find value by key
    ValueType* Find(KeyType key) {
        auto iter = entry_positions.find(key);
        if (iter == entry_positions.end()) {
            return nullptr;
        }
        return &entries[iter->second];
    }
    // Release the values
    std::vector<ValueType> Flush() {
        entry_positions.clear();
        return std::move(entries);
    }
};

}  // namespace sqlynx
