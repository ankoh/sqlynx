// Visualization functions of the differential test oracle (see tools/oracle_ffi.cc).

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <memory>
#include <sstream>
#include <string>
#include <string_view>

#include "dashql/catalog.h"
#include "dashql/script.h"
#include "dashql/visualize/markdown.h"
#include "dashql/visualize/umap.h"
#include "dashql/visualize/vegalite.h"

using namespace dashql;

extern "C" {

/// The result of an oracle call, declared in tools/oracle_ffi.cc
struct DashQLOracleResult {
    uint32_t status;
    char* data;
    size_t length;
};

/// Analyze a script like the visualize snapshot test (the catalog script, if `catalog_text` is not null, is analyzed
/// and loaded with its entry id as rank) and dump every visualization spec: its renderer and dashboard, the generated
/// Vega-Lite JSON and its round trip through ParseVegaLiteToVisualize, the compiled Markdown spec and the compiled
/// UMAP spec. See `dashql-oracle/src/visualize.rs` for the format.
DashQLOracleResult dashql_oracle_visualize(const char* catalog_text, size_t catalog_length, const char* text,
                                           size_t length);

/// ParseVegaLiteToVisualize of a JSON text
DashQLOracleResult dashql_oracle_parse_vegalite(const char* text, size_t length);

/// CompileMarkdownSpec of a row template, dumped like in dashql_oracle_visualize
DashQLOracleResult dashql_oracle_compile_markdown(const char* text, size_t length);
}

namespace {

DashQLOracleResult VisualizeOk(std::string_view out) {
    auto* data = static_cast<char*>(std::malloc(std::max<size_t>(out.size(), 1)));
    std::memcpy(data, out.data(), out.size());
    return DashQLOracleResult{.status = 0, .data = data, .length = out.size()};
}

DashQLOracleResult VisualizeErr(std::string_view message) {
    auto result = VisualizeOk(message);
    result.status = 1;
    return result;
}

/// A length-prefixed string, unambiguous for any bytes
void DumpString(std::ostream& out, std::string_view s) { out << s.size() << ':' << s; }

void DumpMarkdownNode(std::ostream& out, const visualize::MarkdownNode& node, size_t depth) {
    out << std::string(depth * 2, ' ') << buffers::visualization::EnumNameMarkdownNodeType(node.node_type)
        << " value=";
    DumpString(out, node.value);
    out << " url=";
    DumpString(out, node.url);
    out << " title=";
    DumpString(out, node.title);
    out << " language=";
    DumpString(out, node.language);
    out << " level=" << static_cast<uint32_t>(node.level) << " start=" << node.start << " ordered=" << node.ordered
        << " tight=" << node.tight << '\n';
    for (const auto& child : node.children) DumpMarkdownNode(out, *child, depth + 1);
}

void DumpMarkdown(std::ostream& out, const std::shared_ptr<visualize::MarkdownDocument>& markdown) {
    if (!markdown) {
        out << "markdown: null\n";
        return;
    }
    out << "markdown template=";
    DumpString(out, markdown->template_);
    out << " fields=" << markdown->fields.size();
    for (const auto& field : markdown->fields) {
        out << ' ';
        DumpString(out, field);
    }
    out << '\n';
    if (markdown->document) DumpMarkdownNode(out, *markdown->document, 1);
}

template <typename Optional> void DumpOptionalDouble(std::ostream& out, const Optional& value) {
    if (!value.has_value()) {
        out << "null";
        return;
    }
    char buffer[64];
    std::snprintf(buffer, sizeof(buffer), "%.17g", value.value());
    out << buffer;
}

}  // namespace

DashQLOracleResult dashql_oracle_visualize(const char* catalog_text, size_t catalog_length, const char* text,
                                           size_t length) {
    try {
        Catalog catalog;
        std::unique_ptr<Script> catalog_script;
        if (catalog_text != nullptr) {
            catalog_script = std::make_unique<Script>(catalog);
            catalog_script->InsertTextAt(0, std::string_view{catalog_text, catalog_length});
            catalog_script->Scan();
            catalog_script->Parse();
            catalog_script->Analyze();
            catalog.LoadScript(*catalog_script, catalog_script->GetCatalogEntryId());
        }
        Script main{catalog};
        main.InsertTextAt(0, std::string_view{text, length});
        main.Scan();
        main.Parse();
        main.Analyze();

        std::ostringstream out;
        auto& analyzed = *main.analyzed_script;
        analyzed.visualization_specs.ForEach([&](size_t i, VisualizationSpec& spec) {
            out << "spec " << i << " renderer=";
            if (spec.renderer) {
                DumpString(out, *spec.renderer);
            } else {
                out << "null";
            }
            out << " dashboard=";
            if (spec.dashboard.row) out << *spec.dashboard.row; else out << "null";
            out << ',';
            if (spec.dashboard.column) out << *spec.dashboard.column; else out << "null";
            out << ',' << spec.dashboard.width << ',' << spec.dashboard.height << '\n';

            auto vegalite = visualize::GenerateVegaLiteSpec(spec, analyzed);
            out << "vegalite ";
            DumpString(out, vegalite);
            out << "\nroundtrip ";
            DumpString(out, visualize::ParseVegaLiteToVisualize(vegalite));
            out << '\n';

            if (spec.markdown) DumpMarkdown(out, visualize::CompileMarkdownSpec(spec));
            if (spec.umap) {
                auto umap = visualize::CompileUmapSpec(spec, analyzed);
                out << "umap vector=";
                DumpString(out, umap->vector_column);
                out << " category=";
                DumpString(out, umap->category_column);
                out << " label=";
                DumpString(out, umap->label_column);
                if (umap->projection) {
                    out << " method=" << static_cast<uint32_t>(umap->projection->method) << " metric=";
                    DumpString(out, umap->projection->metric);
                    out << " neighbors=";
                    DumpOptionalDouble(out, umap->projection->neighbors);
                    out << " min_dist=";
                    DumpOptionalDouble(out, umap->projection->min_dist);
                }
                out << '\n';
            }
        });
        return VisualizeOk(out.str());
    } catch (std::exception& e) {
        return VisualizeErr(e.what());
    } catch (...) {
        return VisualizeErr("unknown exception");
    }
}

DashQLOracleResult dashql_oracle_parse_vegalite(const char* text, size_t length) {
    try {
        return VisualizeOk(visualize::ParseVegaLiteToVisualize(std::string{text, length}));
    } catch (std::exception& e) {
        return VisualizeErr(e.what());
    }
}

DashQLOracleResult dashql_oracle_compile_markdown(const char* text, size_t length) {
    try {
        VisualizationSpec spec;
        spec.markdown = MarkdownSpec{.ast_node_id = 0, .row_template = std::string{text, length}};
        std::ostringstream out;
        DumpMarkdown(out, visualize::CompileMarkdownSpec(spec));
        return VisualizeOk(out.str());
    } catch (std::exception& e) {
        return VisualizeErr(e.what());
    }
}
