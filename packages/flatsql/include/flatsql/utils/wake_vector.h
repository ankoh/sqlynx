#include <cassert>
#include <deque>
#include <optional>

/// A wake vector maintains state "in the wake" of a read front.
/// In FlatSQL, analysis passes are ususally scanning the ast buffer linearly either ltr or rtl.
/// Passes have to track state of all active children of yet-to-visit nodes during the traversal.
///
/// For LTR scans (i.e. post-order DFS), this results in a moving range of nodes that need to hold state.
/// The range spans from the read front on the right to the smallest NodeID on the left that has an unvisited parent.
/// A wake vector tracks this range explicitly and provides efficient access to state within.
template <typename ValueType> struct WakeVector {
   protected:
    /// The values
    std::deque<std::optional<ValueType>> values;
    /// The offset of the values
    size_t offset = 0;

   public:
    /// Constructor
    WakeVector() = default;
    /// Access an element
    std::optional<ValueType>& operator[](size_t index) {
        assert(index >= offset);
        assert(index <= (offset + values.size()));
        return values[index - offset];
    }
    /// Append an element
    template <typename... Params> ValueType& EmplaceBack(Params&&... args) {
        return values.emplace_back(ValueType{std::forward(args)...}).value();
    }
    /// Erase an element
    void Erase(size_t index) {
        assert(index >= offset);
        assert(index < (offset + values.size()));
        // Erase the element
        values[index - offset].reset();
        // If we erased the first element, truncate from left
        if (index == offset) {
            while (!values[0].has_value()) {
                values.pop_front();
                ++offset;
            }
        }
    }
};
