#pragma once

#include <string>
#include <cassert>
#include <cstring>

namespace dashql::utf8 {

enum class UnicodeType { INVALID, ASCII, UNICODE };
enum class UnicodeInvalidReason { BYTE_MISMATCH, INVALID_UNICODE };

class Utf8Proc {
public:
	/// Distinguishes ASCII, Valid UTF8 and Invalid UTF8 strings
	static UnicodeType Analyze(std::string_view s, UnicodeInvalidReason *invalid_reason = nullptr, size_t *invalid_pos = nullptr);
	/// Performs UTF NFC normalization of string, return value needs to be free'd
	static char* Normalize(std::string_view s);
	/// Returns whether or not the UTF8 string is valid
	static bool IsValid(std::string_view s);
	/// Returns the position (in bytes) of the next grapheme cluster
	static size_t NextGraphemeCluster(std::string_view s, size_t pos);
	/// Returns the position (in bytes) of the previous grapheme cluster
	static size_t PreviousGraphemeCluster(std::string_view s, size_t pos);

	/// Transform a codepoint to utf8 and writes it to "c", sets "sz" to the size of the codepoint
	static bool CodepointToUtf8(int cp, int &sz, char *c);
	/// Returns the codepoint length in bytes when encoded in UTF8
	static int CodepointLength(int cp);
	/// Transform a UTF8 string to a codepoint; returns the codepoint and writes the length of the codepoint (in UTF8) to sz
	static int32_t UTF8ToCodepoint(const char *c, int &sz);
	/// Returns the render width of a single character in a string
	static size_t RenderWidth(std::string_view s, size_t pos);
	static size_t RenderWidth(const std::string &str);

};

}
