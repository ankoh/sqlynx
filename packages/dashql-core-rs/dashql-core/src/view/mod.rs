//! The view model of Hyper query plans, a port of `packages/dashql-core/src/view`.
//!
//! - `json`: the JSON reader and writer of rapidjson 1.1.0 as the C++ view model uses them
//! - `hyper_plan_parser`: `PlanViewModel::ParseHyperPlan` and the derived edges, fragments and pipelines
//! - `plan_view_model`: the view model and its FlatBuffers encoding (`PlanViewModel::Pack`)
//! - `plan_layout`: the tree layout (Walker with the improvements of Buchheim, Juenger and Leipert)

mod hyper_plan_parser;
pub mod json;
mod plan_layout;
mod plan_view_model;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_tpch;

pub use plan_view_model::PlanViewModel;
