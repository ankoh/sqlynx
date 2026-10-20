// Analyzer functions of the differential test oracle (see tools/oracle_ffi.cc).

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <memory>
#include <string>
#include <string_view>

#include "c4/yml/std/std.hpp"
#include "dashql/catalog.h"
#include "dashql/exception.h"
#include "dashql/script.h"
#include "dashql/testing/analyzer_snapshot_test.h"
#include "ryml.hpp"

using namespace dashql;

extern "C" {

/// The result of an oracle call, declared in tools/oracle_ffi.cc
struct DashQLOracleResult {
    uint32_t status;
    char* data;
    size_t length;
};

/// Analyze scripts like the analyzer snapshot test: the catalog script (if `catalog_text` is not null) is analyzed
/// and loaded with its entry id as rank, then the main script is analyzed. The output is YAML with the keys
/// `catalog` (if any) and `script`, each encoded by `AnalyzerSnapshotTest::EncodeScript`.
DashQLOracleResult dashql_oracle_analyze(const char* catalog_text, size_t catalog_length, const char* text,
                                         size_t length);
}

namespace {

DashQLOracleResult AnalyzerOk(std::string_view out) {
    auto* data = static_cast<char*>(std::malloc(std::max<size_t>(out.size(), 1)));
    std::memcpy(data, out.data(), out.size());
    return DashQLOracleResult{.status = 0, .data = data, .length = out.size()};
}

DashQLOracleResult AnalyzerErr(std::string_view message) {
    auto result = AnalyzerOk(message);
    result.status = 1;
    return result;
}

}  // namespace

DashQLOracleResult dashql_oracle_analyze(const char* catalog_text, size_t catalog_length, const char* text,
                                         size_t length) {
    try {
        Catalog catalog;
        std::unique_ptr<Script> catalog_script;
        c4::yml::Tree out_tree;
        auto out_root = out_tree.rootref();
        out_root.set_type(c4::yml::MAP);
        if (catalog_text != nullptr) {
            catalog_script = std::make_unique<Script>(catalog);
            catalog_script->InsertTextAt(0, std::string_view{catalog_text, catalog_length});
            catalog_script->Scan();
            catalog_script->Parse();
            catalog_script->Analyze();
            auto node = out_root.append_child();
            node << c4::yml::key("catalog");
            node |= c4::yml::MAP;
            dashql::testing::AnalyzerSnapshotTest::EncodeScript(node, *catalog_script->analyzed_script, false);
            catalog.LoadScript(*catalog_script, catalog_script->GetCatalogEntryId());
        }
        Script main{catalog};
        main.InsertTextAt(0, std::string_view{text, length});
        main.Scan();
        main.Parse();
        main.Analyze();
        auto node = out_root.append_child();
        node << c4::yml::key("script");
        node |= c4::yml::MAP;
        dashql::testing::AnalyzerSnapshotTest::EncodeScript(node, *main.analyzed_script, true);
        return AnalyzerOk(c4::yml::emitrs_yaml<std::string>(out_tree.rootref(), c4::yml::EmitOptions().max_depth(256)));
    } catch (const dashql::Exception& e) {
        return AnalyzerErr(std::string{buffers::status::EnumNameStatusCode(e.GetCode())} + ": " + e.what());
    } catch (const std::exception& e) {
        return AnalyzerErr(e.what());
    } catch (...) {
        return AnalyzerErr("unknown exception");
    }
}
