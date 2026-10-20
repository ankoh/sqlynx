// Differential test oracle for the Rust port of the Hyper plan view model (src/view).
//
// See tools/oracle_ffi.cc for the result convention. The functions here never throw.

#include <cstdlib>
#include <cstring>
#include <exception>
#include <string>
#include <string_view>

#include "dashql/buffers/index_generated.h"
#include "dashql/exception.h"
#include "dashql/view/plan_view_model.h"
#include "flatbuffers/flatbuffer_builder.h"

using namespace dashql;

extern "C" {

/// The result of an oracle call (same layout as in tools/oracle_ffi.cc)
struct DashQLOracleResult {
    /// 0 if the call succeeded, 1 if it failed (data then holds the error message)
    uint32_t status;
    /// The output bytes (not NUL-terminated)
    char* data;
    /// The output length
    size_t length;
};

/// Configure a plan view model, load a Hyper plan and pack it, the way dashql_plan_view_model_configure and
/// dashql_plan_view_model_load_hyper_plan in src/api.cc do.
///
/// `config` holds the 9 doubles of the PlanLayoutConfig in schema order without max_label_chars:
/// level_height, node_height, node_margin_horizontal, node_padding_left, node_padding_right, icon_width,
/// icon_margin_right, width_per_label_char, node_min_width.
///
/// The output is one line with the status code name of the exception thrown by ParseHyperPlan (empty if the plan
/// was loaded), followed by the packed PlanViewModel flatbuffer. A failed plan is packed after the failure,
/// ComputeLayout only runs on success.
DashQLOracleResult dashql_oracle_plan_view_model(const char* text, size_t length, const double* config,
                                                 uint32_t max_label_chars);
}

namespace {

DashQLOracleResult OkBytes(std::string_view out) {
    auto* data = static_cast<char*>(std::malloc(std::max<size_t>(out.size(), 1)));
    std::memcpy(data, out.data(), out.size());
    return DashQLOracleResult{.status = 0, .data = data, .length = out.size()};
}

DashQLOracleResult ErrBytes(std::string_view message) {
    auto result = OkBytes(message);
    result.status = 1;
    return result;
}

}  // namespace

DashQLOracleResult dashql_oracle_plan_view_model(const char* text, size_t length, const double* config,
                                                 uint32_t max_label_chars) {
    try {
        buffers::view::PlanLayoutConfig layout_config;
        layout_config.mutate_level_height(config[0]);
        layout_config.mutate_node_height(config[1]);
        layout_config.mutate_node_margin_horizontal(config[2]);
        layout_config.mutate_node_padding_left(config[3]);
        layout_config.mutate_node_padding_right(config[4]);
        layout_config.mutate_icon_width(config[5]);
        layout_config.mutate_icon_margin_right(config[6]);
        layout_config.mutate_max_label_chars(max_label_chars);
        layout_config.mutate_width_per_label_char(config[7]);
        layout_config.mutate_node_min_width(config[8]);

        PlanViewModel view_model;
        view_model.Configure(layout_config);
        std::string status;
        try {
            view_model.ParseHyperPlan(std::string_view{text, length});
            view_model.ComputeLayout();
        } catch (const dashql::Exception& e) {
            status = buffers::status::EnumNameStatusCode(e.GetCode());
        }

        flatbuffers::FlatBufferBuilder fb;
        fb.Finish(view_model.Pack(fb));
        std::string out = status + "\n";
        out.append(reinterpret_cast<const char*>(fb.GetBufferPointer()), fb.GetSize());
        return OkBytes(out);
    } catch (const std::exception& e) {
        return ErrBytes(e.what());
    } catch (...) {
        return ErrBytes("unknown exception");
    }
}
