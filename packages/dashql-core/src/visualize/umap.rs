//! The UMAP renderer spec (`umap.cc`).

use super::vegalite_generator::resolve_field_name;
use crate::analyzer::types::VisualizationSpec;
use crate::analyzer::AnalyzedScript;
use dashql_buffers::visualization::{
    UmapProjectionMethod, UmapProjectionSpec, UmapProjectionSpecArgs, UmapSpec, UmapSpecArgs,
};
use flatbuffers::{FlatBufferBuilder, WIPOffset};

/// The projection of a UMAP spec (`UmapProjectionSpecT`)
#[derive(Clone, Debug, PartialEq)]
pub struct UmapProjectionDocument {
    /// The projection method
    pub method: UmapProjectionMethod,
    /// Empty if not set
    pub metric: String,
    /// The number of neighbors, if set
    pub neighbors: Option<f64>,
    /// The minimum distance of embedded points, if set
    pub min_dist: Option<f64>,
}

/// A compiled UMAP spec (`UmapSpecT`). Empty columns are not set.
#[derive(Clone, Debug, PartialEq)]
pub struct UmapDocument {
    /// The column with the vectors to project
    pub vector_column: String,
    /// The column that categorizes the points
    pub category_column: String,
    /// The column with the point labels
    pub label_column: String,
    /// The projection parameters
    pub projection: Option<UmapProjectionDocument>,
}

/// Compile the UMAP spec of a visualization (`CompileUmapSpec`), `None` if it has none
pub fn compile_umap_spec(spec: &VisualizationSpec, script: &AnalyzedScript) -> Option<UmapDocument> {
    let input = spec.umap.as_ref()?;
    let column = |expression_id: Option<u32>| -> String {
        expression_id
            .map(|id| super::into_string(resolve_field_name(script, id).to_vec()))
            .unwrap_or_default()
    };
    Some(UmapDocument {
        vector_column: column(input.vector_expression_id),
        category_column: column(input.category_expression_id),
        label_column: column(input.label_expression_id),
        projection: Some(UmapProjectionDocument {
            method: UmapProjectionMethod::UMAP,
            metric: input.projection.metric.clone().unwrap_or_default(),
            neighbors: input.projection.neighbors,
            min_dist: input.projection.min_dist,
        }),
    })
}

/// Pack a compiled spec like the C++ object API does (`PackUmapSpec`): empty strings are omitted
pub fn pack_umap_spec<'a>(builder: &mut FlatBufferBuilder<'a>, spec: &UmapDocument) -> WIPOffset<UmapSpec<'a>> {
    let mut string = |s: &str| if s.is_empty() { None } else { Some(builder.create_string(s)) };
    let vector_column = string(&spec.vector_column);
    let category_column = string(&spec.category_column);
    let label_column = string(&spec.label_column);
    let projection = spec.projection.as_ref().map(|p| {
        let metric = if p.metric.is_empty() { None } else { Some(builder.create_string(&p.metric)) };
        UmapProjectionSpec::create(
            builder,
            &UmapProjectionSpecArgs { method: p.method, metric, neighbors: p.neighbors, min_dist: p.min_dist },
        )
    });
    UmapSpec::create(builder, &UmapSpecArgs { vector_column, category_column, label_column, projection })
}
