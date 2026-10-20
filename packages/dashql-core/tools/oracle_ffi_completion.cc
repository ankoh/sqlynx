// Completion function of the differential test oracle (see tools/oracle_ffi.cc).

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <memory>
#include <string>
#include <string_view>

#include "c4/yml/std/std.hpp"
#include "dashql/analyzer/completion.h"
#include "dashql/catalog.h"
#include "dashql/exception.h"
#include "dashql/script.h"
#include "dashql/testing/completion_snapshot_test.h"
#include "dashql/testing/yaml_tests.h"
#include "ryml.hpp"

using namespace dashql;

extern "C" {

/// The result of an oracle call, declared in tools/oracle_ffi.cc
struct DashQLOracleResult {
    uint32_t status;
    char* data;
    size_t length;
};

/// Complete like the completion snapshot test: the catalog script (if `catalog_text` is not null) is analyzed and
/// loaded with its entry id as rank, then the editor script is analyzed, the cursor is moved to `cursor_offset`, and
/// the completion is encoded as the `completions` node of the snapshots.
DashQLOracleResult dashql_oracle_complete(const char* catalog_text, size_t catalog_length, const char* text,
                                          size_t length, size_t cursor_offset, size_t limit);
}

namespace {

DashQLOracleResult CompletionResult(uint32_t status, std::string_view out) {
    auto* data = static_cast<char*>(std::malloc(std::max<size_t>(out.size(), 1)));
    std::memcpy(data, out.data(), out.size());
    return DashQLOracleResult{.status = status, .data = data, .length = out.size()};
}

}  // namespace

DashQLOracleResult dashql_oracle_complete(const char* catalog_text, size_t catalog_length, const char* text,
                                          size_t length, size_t cursor_offset, size_t limit) {
    try {
        Catalog catalog;
        std::unique_ptr<Script> catalog_script;
        if (catalog_text != nullptr) {
            catalog_script = std::make_unique<Script>(catalog);
            catalog_script->InsertTextAt(0, std::string_view{catalog_text, catalog_length});
            catalog_script->Analyze();
            catalog.LoadScript(*catalog_script, catalog_script->GetCatalogEntryId());
        }
        Script editor{catalog};
        editor.InsertTextAt(0, std::string_view{text, length});
        editor.Analyze();
        editor.MoveCursor(cursor_offset);
        auto completion = editor.CompleteAtCursor(limit);

        c4::yml::Tree out_tree;
        auto out_root = out_tree.rootref();
        out_root.set_type(c4::yml::MAP);
        out_root.append_child() << c4::yml::key("limit") << limit;
        // The encoder reads the target symbol, which completions inside comments do not have
        if (!completion->GetTargetSymbol().has_value()) {
            out_root.append_child() << c4::yml::key("no-target") << 1;
        } else {
            dashql::testing::CompletionSnapshotTest::EncodeCompletion(out_root, *completion);
            dashql::testing::EncodeLocationText(out_root, completion->GetTargetSymbol()->symbol.location,
                                                editor.scanned_script->GetInput(), "text");
        }
        return CompletionResult(
            0, c4::yml::emitrs_yaml<std::string>(out_tree.rootref(), c4::yml::EmitOptions().max_depth(256)));
    } catch (const dashql::Exception& e) {
        return CompletionResult(1, buffers::status::EnumNameStatusCode(e.GetCode()));
    } catch (const std::exception& e) {
        return CompletionResult(1, e.what());
    } catch (...) {
        return CompletionResult(1, "unknown exception");
    }
}
