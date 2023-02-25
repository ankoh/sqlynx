/// Significant parts of this file were derived from the Rust B-tree Rope "ropey".
///
/// Copyright (c) 2017 Nathan Vegdahl
///
/// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
/// documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
/// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
/// permit persons to whom the Software is furnished to do so, subject to the following conditions:
///
/// The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
/// Software.
///
/// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
/// WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS
/// OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
/// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

#include <cstddef>
#include <cstdint>
#include <span>

namespace flatsql::crlf {

/// Returns whether the given byte index in `text` is a valid splitting point.
/// Valid splitting point in this case means that it _is_ a utf8 code point boundary and _is not_ the middle of a CRLF
/// pair.
constexpr bool isValidSplit(std::span<const std::byte> buffer, size_t pos) {
    assert(pos <= buffer.size());
    if (pos == 0 || pos == buffer.size()) {
        return true;
    } else {
        return ((buffer[pos] >> 6) != std::byte{0b10}) &&
               ((buffer[pos - 1] != std::byte{0x0D}) | (buffer[pos] != std::byte{0x0A}));
    }
}

/// Returns whether the seam between `left` and `right` is a valid splitting point.
/// Valid splitting point in this case means that it _is_ a utf8 code point boundary and _is not_ the middle of a CRLF
/// pair.
constexpr bool seamIsValidSplit(std::span<const std::byte> left, std::span<const std::byte> right) {
    assert(!left.empty() && !right.empty());
    return ((right[0] >> 6) != std::byte{0b10}) &&
           ((left[left.size() - 1] != std::byte{0x0D}) | (right[0] != std::byte{0x0A}));
}

/// Returns the first split before (but not including) the given byte boundary.
/// This will return back the passed byte boundary if it is at the start of the string.
constexpr size_t findPreviousSplit(std::span<const std::byte> buffer, size_t pos) {
    assert(pos <= buffer.size());
    if (pos == 0) {
        return 0;
    } else {
        auto candidate = pos - 1;
        while (!isValidSplit(buffer, candidate)) {
            --candidate;
        }
        return candidate;
    }
}

/// Returns the first split after (but not including) the given byte boundary.
/// This will return back the passed byte boundary if it is at the end of the string.
constexpr size_t findNextSplit(std::span<const std::byte> buffer, size_t pos) {
    assert(pos <= buffer.size());
    if (pos == buffer.size()) {
        return buffer.size();
    } else {
        auto candidate = pos + 1;
        while (!isValidSplit(buffer, candidate)) {
            ++candidate;
        }
        return candidate;
    }
}

/// Finds the split nearest to the given byte that is not the left or right edge of the text.
///
/// There is only one circumstance where the left or right edge will be returned:
/// if the entire text is a single unbroken segment, then the right edge of the text is returned.
constexpr size_t nearestInternalSplit(std::span<const std::byte> buffer, size_t pos) {
    assert(pos <= buffer.size());

    // Find the two nearest segment boundaries
    size_t left;
    if (isValidSplit(buffer, pos) && pos != buffer.size()) {
        left = pos;
    } else {
        left = findPreviousSplit(buffer, pos);
    }
    size_t right = findNextSplit(buffer, pos);

    // Otherwise, return the closest of left and right that isn't the start or end of the string
    if (left == 0 || (right != buffer.size() && (pos - left) >= (right - pos))) {
        return right;
    } else {
        return left;
    }
}

constexpr size_t findGoodSplit(std::span<const std::byte> buffer, size_t pos, bool bias_left) {
    assert(pos <= buffer.size());
    if (isValidSplit(buffer, pos)) {
        return pos;
    } else {
        auto prev = findPreviousSplit(buffer, pos);
        auto next = findNextSplit(buffer, pos);
        if (bias_left) {
            return (prev > 0) ? prev : next;
        } else {
            return (next < buffer.size()) ? next : prev;
        }
    }
}

}  // namespace flatsql
