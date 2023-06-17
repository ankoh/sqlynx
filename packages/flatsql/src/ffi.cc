#include <span>

#include "flatbuffers/flatbuffers.h"
#include "flatsql/parser/parse_context.h"
#include "flatsql/parser/scanner.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/script.h"
#include "flatsql/text/rope.h"

using namespace flatsql;
using namespace flatsql::parser;

/// Log to console
#ifdef WASM
__attribute__((__import_module__("env"), __import_name__("log"))) extern void log(const char* text, size_t textLength);
#else
extern void log(const char* text, size_t textLength) { std::cout << std::string_view{text, textLength} << std::endl; }
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

/// Create a script
extern "C" Script* flatsql_script_new() { return new Script(); }
/// Delete a script
extern "C" void flatsql_script_delete(Script* script) { delete script; }
/// Insert char at a position
extern "C" void flatsql_script_insert_char_at(Script* script, size_t offset, char unicode) {
    script->InsertCharAt(offset, unicode);
}
/// Insert text at a position
extern "C" void flatsql_script_insert_text_at(Script* script, size_t offset, char* text_ptr, size_t text_length) {
    std::string_view text{text_ptr, text_length};
    script->InsertTextAt(offset, text);
}
/// Erase a text range
extern "C" void flatsql_script_erase_text_range(Script* script, size_t offset, size_t count) {
    script->EraseTextRange(offset, count);
}
/// Get the rope content as string
extern "C" FFIResult* flatsql_script_to_string(Script* script) {
    auto text = std::make_unique<std::string>(std::move(script->ToString()));
    auto result = new FFIResult();
    result->status_code = 0;
    result->data_ptr = text->data();
    result->data_length = text->length();
    result->owner_ptr = text.release();
    result->owner_deleter = [](void* buffer) { delete reinterpret_cast<std::string*>(buffer); };
    return result;
}

/// Parse a script
extern "C" FFIResult* flatsql_script_parse(Script* script) {
    script->Parse();

    // Pack a parsed script
    flatbuffers::FlatBufferBuilder fb;
    auto parsed = script->PackParsedScript(fb);
    fb.Finish(parsed);

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

/// Analyze a script
extern "C" FFIResult* flatsql_script_analyze(Script* script, Script* external) {
    script->Analyze(external);

    // Pack a parsed script
    flatbuffers::FlatBufferBuilder fb;
    auto parsed = script->PackAnalyzedScript(fb);
    fb.Finish(parsed);

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
