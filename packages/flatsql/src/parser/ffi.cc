#include <span>

#include "flatbuffers/flatbuffers.h"
#include "flatsql/parser/parser.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/text/rope.h"

using namespace flatsql;
using namespace flatsql::parser;
namespace proto = flatsql::proto;

/// Log to console
#ifdef WASM
__attribute__((__import_module__("env"), __import_name__("log"))) extern void log(const char* text, size_t textLength);
#else
extern void log(const char* text, size_t textLength) { std::cout << std::string_view{text, textLength}; }
#endif

/// Log a std::string
void log(std::string text) { return log(text.data(), text.size()); }
/// Log a string_view
void log(std::string_view text) { return log(text.data(), text.size()); }

/// Allocate memory
extern "C" std::byte* flatsql_malloc(size_t length) { return new std::byte[length]; }
/// Delete memory
extern "C" void flatsql_free(void* buffer) { delete[] reinterpret_cast<std::byte*>(buffer); }

/// A managed FFI result container
struct FFIResult {
    uint32_t status_code;
    uint32_t data_length;
    void* data_ptr;
    void* owner_ptr;
    void (*owner_deleter)(void*);
};
/// Delete a result
extern "C" void flatsql_result_delete(FFIResult* result) {
    result->owner_deleter(result->owner_ptr);
    result->owner_ptr = nullptr;
    result->owner_deleter = nullptr;
    delete result;
}

/// Create a rope
extern "C" rope::Rope* flatsql_rope_new() { return new rope::Rope(1024); }
/// Delete a rope
extern "C" void flatsql_rope_delete(rope::Rope* rope) { delete rope; }
/// Insert char at a position
extern "C" void flatsql_rope_insert_char_at(rope::Rope* rope, size_t offset, char unicode) {
    std::string_view text{&unicode, 1};
    rope->Insert(offset, text);
}
/// Insert text at a position
extern "C" void flatsql_rope_insert_text_at(rope::Rope* rope, size_t offset, char* text_ptr, size_t text_length) {
    std::string_view text{text_ptr, text_length};
    rope->Insert(offset, text);
}
/// Erase a text range
extern "C" void flatsql_rope_erase_text_range(rope::Rope* rope, size_t offset, size_t count) {
    rope->Remove(offset, count);
}
/// Get the rope content as string
extern "C" FFIResult* flatsql_rope_to_string(rope::Rope* rope) {
    auto text = std::make_unique<std::string>(std::move(rope->ToString()));

    auto result = new FFIResult();
    result->status_code = 0;
    result->data_ptr = text->data();
    result->data_length = text->length();
    result->owner_ptr = text.release();
    result->owner_deleter = [](void* buffer) { delete reinterpret_cast<std::string*>(buffer); };
    return result;
}

/// Parse a rope
extern "C" FFIResult* flatsql_parse_rope(rope::Rope* data) {
    // Parse the program
    auto program = ParseContext::Parse(*data);

    // Pack the flatbuffer program
    flatbuffers::FlatBufferBuilder fb;
    auto program_ofs = proto::Program::Pack(fb, program.get());
    fb.Finish(program_ofs);

    // Store the buffer
    auto detached = std::make_unique<flatbuffers::DetachedBuffer>(std::move(fb.Release()));
    auto result = new FFIResult();
    result->status_code = 0;
    result->data_ptr = detached->data();
    result->data_length = detached->size();
    result->owner_ptr = detached.release();
    result->owner_deleter = [](void* buffer) { delete reinterpret_cast<flatbuffers::DetachedBuffer*>(buffer); };
    return result;
}

#ifdef WASM
extern "C" int main() { return 0; }
#endif
