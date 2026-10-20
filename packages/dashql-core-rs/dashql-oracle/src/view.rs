//! Oracle functions for the view port (`packages/dashql-core/tools/oracle_ffi_view.cc`).

use crate::OracleResult;
use std::os::raw::c_char;

extern "C" {
    fn dashql_oracle_plan_view_model(
        text: *const c_char,
        length: usize,
        config: *const f64,
        max_label_chars: u32,
    ) -> OracleResult;
}

/// The layout config of a plan view model (`PlanLayoutConfig` in plan_view_model.fbs)
#[derive(Clone, Copy, Debug, Default)]
pub struct PlanLayoutConfig {
    pub level_height: f64,
    pub node_height: f64,
    pub node_margin_horizontal: f64,
    pub node_padding_left: f64,
    pub node_padding_right: f64,
    pub icon_width: f64,
    pub icon_margin_right: f64,
    pub max_label_chars: u32,
    pub width_per_label_char: f64,
    pub node_min_width: f64,
}

/// A plan loaded by the C++ plan view model
#[derive(Clone, Debug)]
pub struct LoadedPlan {
    /// The status code name of the exception thrown by `ParseHyperPlan`, `None` if the plan was loaded
    pub error: Option<String>,
    /// The packed `PlanViewModel` flatbuffer
    pub buffer: Vec<u8>,
}


/// Configure a C++ plan view model, load a Hyper plan and pack it (`dashql_oracle_plan_view_model`).
///
/// Mirrors `dashql_plan_view_model_configure` and `dashql_plan_view_model_load_hyper_plan`: `ParseHyperPlan`
/// followed by `ComputeLayout`. A plan that fails to parse is packed after the failure.
pub fn load_hyper_plan(plan: &[u8], config: &PlanLayoutConfig) -> Result<LoadedPlan, String> {
    let doubles = [
        config.level_height,
        config.node_height,
        config.node_margin_horizontal,
        config.node_padding_left,
        config.node_padding_right,
        config.icon_width,
        config.icon_margin_right,
        config.width_per_label_char,
        config.node_min_width,
    ];
    // SAFETY: the oracle reads `plan.len()` bytes of `plan` and 9 doubles, and returns an unreleased result.
    let out = unsafe {
        crate::take_bytes(dashql_oracle_plan_view_model(
            plan.as_ptr() as *const c_char,
            plan.len(),
            doubles.as_ptr(),
            config.max_label_chars,
        ))
    }?;
    let newline = out.iter().position(|b| *b == b'\n').ok_or("oracle output without status line")?;
    let status = String::from_utf8_lossy(&out[..newline]).into_owned();
    Ok(LoadedPlan {
        error: if status.is_empty() { None } else { Some(status) },
        buffer: out[newline + 1..].to_vec(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_plan() {
        let config = PlanLayoutConfig { level_height: 64.0, node_height: 32.0, ..Default::default() };
        let loaded = load_hyper_plan(br#"{"operator":"scan"}"#, &config).unwrap();
        assert_eq!(loaded.error, None);
        assert!(!loaded.buffer.is_empty());
        let failed = load_hyper_plan(b"{", &config).unwrap();
        assert_eq!(failed.error.as_deref(), Some("VIEWMODEL_INPUT_JSON_PARSER_ERROR"));
    }
}
