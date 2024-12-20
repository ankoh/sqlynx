use std::sync::Arc;

use arrow::datatypes::{DataType, Field, Schema, SchemaRef};
use datafusion_expr::function::{ExpressionArgs, PartitionEvaluatorArgs, WindowUDFFieldArgs};
use datafusion_expr::{PartitionEvaluator, ReversedUDWF, WindowUDF};
use datafusion_physical_expr::expressions::Column;
use datafusion_physical_expr::window::BuiltInWindowFunctionExpr;
use datafusion_physical_expr::{PhysicalExpr, PhysicalSortExpr};

#[derive(Clone, Debug)]
struct WindowUDFExpr {
    fun: Arc<WindowUDF>,
    args: Vec<Arc<dyn PhysicalExpr>>,
    /// Display name
    name: String,
    /// Types of input expressions
    input_types: Vec<DataType>,
    /// This is set to `true` only if the user-defined window function
    /// expression supports evaluation in reverse order, and the
    /// evaluation order is reversed.
    is_reversed: bool,
    /// Set to `true` if `IGNORE NULLS` is defined, `false` otherwise.
    ignore_nulls: bool,
}

impl BuiltInWindowFunctionExpr for WindowUDFExpr {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn field(&self) -> datafusion_common::Result<Field> {
        self.fun
            .field(WindowUDFFieldArgs::new(&self.input_types, &self.name))
    }

    fn expressions(&self) -> Vec<Arc<dyn PhysicalExpr>> {
        self.fun
            .expressions(ExpressionArgs::new(&self.args, &self.input_types))
    }

    fn create_evaluator(&self) -> datafusion_common::Result<Box<dyn PartitionEvaluator>> {
        self.fun
            .partition_evaluator_factory(PartitionEvaluatorArgs::new(
                &self.args,
                &self.input_types,
                self.is_reversed,
                self.ignore_nulls,
            ))
    }

    fn name(&self) -> &str {
        &self.name
    }

    fn reverse_expr(&self) -> Option<Arc<dyn BuiltInWindowFunctionExpr>> {
        match self.fun.reverse_expr() {
            ReversedUDWF::Identical => Some(Arc::new(self.clone())),
            ReversedUDWF::NotSupported => None,
            ReversedUDWF::Reversed(fun) => Some(Arc::new(WindowUDFExpr {
                fun,
                args: self.args.clone(),
                name: self.name.clone(),
                input_types: self.input_types.clone(),
                is_reversed: !self.is_reversed,
                ignore_nulls: self.ignore_nulls,
            })),
        }
    }

    fn get_result_ordering(&self, schema: &SchemaRef) -> Option<PhysicalSortExpr> {
        self.fun
            .sort_options()
            .zip(schema.column_with_name(self.name()))
            .map(|(options, (idx, field))| {
                let expr = Arc::new(Column::new(field.name(), idx));
                PhysicalSortExpr { expr, options }
            })
    }
}


/// XXX This is exported in the latest `main`.
///     Remove this function asap.
///
/// Source: https://github.com/apache/datafusion/blob/main/datafusion/physical-plan/src/windows/mod.rs#L157
pub fn create_udwf_window_expr(
    fun: &Arc<WindowUDF>,
    args: &[Arc<dyn PhysicalExpr>],
    input_schema: &Schema,
    name: String,
    ignore_nulls: bool,
) -> datafusion_common::Result<Arc<dyn BuiltInWindowFunctionExpr>> {
    // need to get the types into an owned vec for some reason
    let input_types: Vec<_> = args
        .iter()
        .map(|arg| arg.data_type(input_schema))
        .collect::<datafusion_common::Result<_>>()?;

    let udwf_expr = Arc::new(WindowUDFExpr {
        fun: Arc::clone(fun),
        args: args.to_vec(),
        input_types,
        name,
        is_reversed: false,
        ignore_nulls,
    });

    let _ = udwf_expr.create_evaluator()?;

    Ok(udwf_expr)
}
