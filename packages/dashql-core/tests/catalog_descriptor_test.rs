//! Catalog entries backed by descriptor bytes: validation, import, name resolution against the
//! declarations, replacement, ranking, description and removal.

use dashql_buffers::analyzer::{
    FunctionDeclarationT, FunctionParamT, QualifiedFunctionNameT, QualifiedTableNameT, TableColumnT, TableT,
};
use dashql_buffers::catalog::{CatalogDescriptorT, CatalogEntryType};
use dashql_core::analyzer::ColumnResolution;
use dashql_core::catalog::descriptor::validate_descriptor;
use dashql_core::catalog::{Catalog, CatalogEntryId};
use dashql_core::pack::pack_catalog_descriptor;
use dashql_core::script::Script;

fn table(database: &str, schema: &str, name: &str, columns: &[&str]) -> TableT {
    let mut table = TableT::default();
    let mut table_name = QualifiedTableNameT::default();
    table_name.database_name = Some(database.to_string());
    table_name.schema_name = Some(schema.to_string());
    table_name.table_name = Some(name.to_string());
    table.table_name = Some(Box::new(table_name));
    table.table_columns = Some(
        columns
            .iter()
            .map(|c| {
                let mut column = TableColumnT::default();
                column.column_name = Some(c.to_string());
                column
            })
            .collect(),
    );
    table
}

fn function(schema: &str, name: &str, params: &[(&str, &str)], return_type: &str, aggregate: bool) -> FunctionDeclarationT {
    let mut function = FunctionDeclarationT::default();
    let mut function_name = QualifiedFunctionNameT::default();
    function_name.database_name = Some(String::new());
    function_name.schema_name = Some(schema.to_string());
    function_name.function_name = Some(name.to_string());
    function.function_name = Some(Box::new(function_name));
    function.params = Some(
        params
            .iter()
            .map(|(n, t)| {
                let mut param = FunctionParamT::default();
                param.param_name = Some(n.to_string());
                param.param_type = Some(t.to_string());
                param
            })
            .collect(),
    );
    function.return_type = Some(return_type.to_string());
    function.is_aggregate = aggregate;
    function
}

fn encode(tables: Vec<TableT>, functions: Vec<FunctionDeclarationT>) -> Vec<u8> {
    let mut descriptor = CatalogDescriptorT::default();
    descriptor.tables = Some(tables);
    descriptor.function_declarations = Some(functions);
    let mut builder = flatbuffers::FlatBufferBuilder::new();
    let packed = descriptor.pack(&mut builder);
    builder.finish(packed, None);
    builder.finished_data().to_vec()
}

fn tables_only(tables: Vec<TableT>) -> Vec<u8> {
    encode(tables, vec![])
}

fn add(catalog: &mut Catalog, rank: u32, bytes: &[u8]) -> CatalogEntryId {
    let id = catalog.allocate_entry_id();
    catalog.replace_descriptor(id, rank, bytes).unwrap();
    id
}

/// The messages of the validation failure of a descriptor
fn validation_error(bytes: &[u8]) -> String {
    validate_descriptor(bytes).unwrap_err().message
}

/// Describe the column refs of a query as `spelled -> table.column` or `?`
fn resolve(catalog: &Catalog, sql: &str) -> Vec<String> {
    let mut script = Script::new(catalog);
    script.insert_text_at(0, sql);
    script.analyze(catalog, true).unwrap();
    let analyzed = script.analyzed.clone().unwrap();
    let mut expressions: Vec<_> = analyzed.expressions.iter().collect();
    expressions.sort_by_key(|e| analyzed.parsed.nodes[e.ast_node_id as usize].symbol_span().offset());
    expressions
        .into_iter()
        .filter_map(|e| e.column_ref())
        .map(|column_ref| {
            let spelled = column_ref.column_name.column_name.text().to_string();
            match (column_ref.resolved, &column_ref.resolved_ids) {
                (ColumnResolution::Unresolved, _) | (_, None) => format!("{spelled} -> ?"),
                (_, Some(ids)) => {
                    let (table_id, column) = ids.catalog_table_column_id.unpack_table_column_id();
                    let table = catalog.table_by_id(table_id).expect("catalog table");
                    format!("{spelled} -> {}.{}", table.table_name.table_name.text(), table.table_columns[column as usize].column_name.text())
                }
            }
        })
        .collect()
}

#[test]
fn validation_accepts_empty_and_well_formed_descriptors() {
    assert!(validate_descriptor(&encode(vec![], vec![])).is_ok());
    let bytes = encode(
        vec![table("", "main", "t", &["a", "b"]), table("db", "main", "t", &["a"])],
        vec![function("main", "f", &[("x", "int"), ("", "int")], "int", false)],
    );
    let descriptor = validate_descriptor(&bytes).unwrap();
    assert_eq!(descriptor.tables().unwrap().len(), 2);
    assert_eq!(descriptor.function_declarations().unwrap().len(), 1);
}

#[test]
fn validation_rejects_malformed_bytes() {
    assert_eq!(validation_error(&[]), "invalid CatalogDescriptor FlatBuffer");
    assert_eq!(validation_error(&[1, 2, 3]), "invalid CatalogDescriptor FlatBuffer");
}

#[test]
fn validation_rejects_bad_tables() {
    assert_eq!(validation_error(&tables_only(vec![table("", "", "", &[])])), "invalid catalog descriptor name or type");
    assert_eq!(validation_error(&tables_only(vec![table("", "", "a\0b", &[])])), "invalid catalog descriptor name or type");
    assert_eq!(validation_error(&tables_only(vec![table("d\0", "", "t", &[])])), "invalid catalog descriptor name or type");
    assert_eq!(validation_error(&tables_only(vec![table("", "s\0", "t", &[])])), "invalid catalog descriptor name or type");
    assert_eq!(
        validation_error(&tables_only(vec![table("", "s", "t", &[]), table("", "s", "t", &[])])),
        "duplicate descriptor table name"
    );
    assert_eq!(validation_error(&tables_only(vec![table("", "s", "t", &["a", "a"])])), "duplicate descriptor column name");
    assert_eq!(validation_error(&tables_only(vec![table("", "s", "t", &[""])])), "invalid catalog descriptor name or type");
    let mut nameless = table("", "", "t", &[]);
    nameless.table_name = None;
    assert_eq!(validation_error(&tables_only(vec![nameless])), "missing descriptor table name");
    // Equal table names in different schemas are fine
    assert!(validate_descriptor(&tables_only(vec![table("", "s", "t", &[]), table("", "u", "t", &[])])).is_ok());
}

#[test]
fn validation_rejects_bad_functions() {
    let functions = |f: FunctionDeclarationT| validation_error(&encode(vec![], vec![f]));
    assert_eq!(functions(function("s", "", &[], "int", false)), "invalid catalog descriptor name or type");
    assert_eq!(functions(function("s", "f", &[], "", false)), "invalid catalog descriptor name or type");
    assert_eq!(functions(function("s", "f", &[("x", "")], "int", false)), "invalid catalog descriptor name or type");
    assert_eq!(functions(function("s", "f", &[("x", "int"), ("x", "int")], "int", false)), "duplicate descriptor parameter name");
    let mut nameless = function("s", "f", &[], "int", false);
    nameless.function_name = None;
    assert_eq!(functions(nameless), "missing descriptor function name");
}

#[test]
fn import_resolves_scripts_against_descriptor_tables() {
    let mut catalog = Catalog::new();
    let version = catalog.version();
    let id = add(&mut catalog, 5, &tables_only(vec![table("db", "main", "orders", &["id", "total"])]));
    assert!(catalog.version() > version);
    assert!(catalog.contains(id));

    let data = catalog.entry(id).unwrap().data();
    assert_eq!(data.table_declarations.len(), 1);
    let declaration = &data.table_declarations[0];
    assert_eq!(declaration.table_name.table_name.text(), "orders");
    assert_eq!(declaration.table_columns.len(), 2);
    assert_eq!(declaration.table_columns[1].column_index(), 1);
    assert_eq!(declaration.column_by_name("total").unwrap().column_index(), 1);
    assert!(declaration.column_by_name("missing").is_none());
    assert!(catalog.databases().contains_key("db"));
    assert!(catalog.schemas().contains_key(&("db".into(), "main".into())));

    assert_eq!(resolve(&catalog, "select id, total, nope from db.main.orders"), vec!["id -> orders.id", "total -> orders.total", "nope -> ?"]);
    // The unqualified name resolves everywhere
    assert_eq!(resolve(&catalog, "select total from orders"), vec!["total -> orders.total"]);
}

#[test]
fn columns_of_descriptor_tables_are_ambiguous_across_tables() {
    let mut catalog = Catalog::new();
    add(&mut catalog, 0, &tables_only(vec![table("", "main", "a", &["id"]), table("", "main", "b", &["id", "x"])]));
    assert_eq!(resolve(&catalog, "select x from a, b"), vec!["x -> b.x"]);
    assert_eq!(resolve(&catalog, "select a.id, b.id from a, b"), vec!["id -> a.id", "id -> b.id"]);
}

#[test]
fn import_registers_functions() {
    let mut catalog = Catalog::new();
    let id = add(
        &mut catalog,
        0,
        &encode(vec![], vec![function("main", "twice", &[("x", "int")], "int", false), function("main", "total", &[("x", "int")], "int", true)]),
    );
    let data = catalog.entry(id).unwrap().data();
    assert_eq!(data.function_declarations.len(), 2);
    let twice = &data.function_declarations[0];
    assert_eq!(twice.function_name.function_name.text(), "twice");
    assert_eq!(&*twice.return_type, "int");
    assert_eq!(twice.params.len(), 1);
    assert_eq!(&*twice.params[0].param_type, "int");
    assert!(!twice.is_aggregate);
    assert!(data.function_declarations[1].is_aggregate);
}

#[test]
fn descriptor_round_trips_through_pack() {
    let mut catalog = Catalog::new();
    let bytes = encode(
        vec![table("db", "main", "t", &["a", "b"])],
        vec![function("main", "f", &[("x", "text")], "int", true)],
    );
    let id = add(&mut catalog, 0, &bytes);
    let packed = pack_catalog_descriptor(catalog.entry(id).unwrap().data()).unwrap();
    let descriptor = validate_descriptor(&packed).unwrap();
    let tables = descriptor.tables().unwrap();
    assert_eq!(tables.len(), 1);
    assert_eq!(tables.get(0).table_name().unwrap().table_name(), Some("t"));
    assert_eq!(tables.get(0).table_columns().unwrap().len(), 2);
    let functions = descriptor.function_declarations().unwrap();
    assert_eq!(functions.get(0).function_name().unwrap().function_name(), Some("f"));
    assert!(functions.get(0).is_aggregate());
    assert_eq!(functions.get(0).return_type(), Some("int"));
    assert_eq!(functions.get(0).params().unwrap().get(0).param_type(), Some("text"));
}

#[test]
fn replace_swaps_the_declarations_of_an_entry() {
    let mut catalog = Catalog::new();
    let id = add(&mut catalog, 0, &tables_only(vec![table("", "main", "old", &["a"])]));
    let version = catalog.version();
    catalog.replace_descriptor(id, 0, &tables_only(vec![table("", "main", "new", &["a"])])).unwrap();
    assert!(catalog.version() > version);
    let data = catalog.entry(id).unwrap().data();
    assert_eq!(data.table_declarations.len(), 1);
    assert_eq!(data.table_declarations[0].table_name.table_name.text(), "new");
    assert_eq!(resolve(&catalog, "select a from old"), vec!["a -> ?"]);
    assert_eq!(resolve(&catalog, "select a from new"), vec!["a -> new.a"]);
}

#[test]
fn replace_rejects_unknown_and_colliding_ids() {
    let mut catalog = Catalog::new();
    let bytes = tables_only(vec![table("", "main", "t", &["a"])]);
    // Never allocated
    assert!(catalog.replace_descriptor(1, 0, &bytes).is_err());
    assert!(catalog.replace_descriptor(0, 0, &bytes).is_err());
    let error = catalog.replace_descriptor(catalog.allocate_entry_id() + 100, 0, &bytes).unwrap_err();
    assert_eq!(error.message, "invalid or colliding receiver catalog entry ID");

    // An entry of a script cannot be replaced by a descriptor
    let mut script = Script::new(&catalog);
    script.insert_text_at(0, "create table s (a int)");
    script.analyze(&catalog, true).unwrap();
    catalog.load_script(script.analyzed.clone().unwrap(), 0).unwrap();
    let error = catalog.replace_descriptor(script.catalog_entry_id(), 0, &bytes).unwrap_err();
    assert_eq!(error.message, "invalid or colliding receiver catalog entry ID");
}

#[test]
fn invalid_replacement_keeps_the_catalog() {
    let mut catalog = Catalog::new();
    let id = add(&mut catalog, 0, &tables_only(vec![table("", "main", "keep", &["a"])]));
    let version = catalog.version();
    assert!(catalog.replace_descriptor(id, 0, &tables_only(vec![table("", "main", "", &[])])).is_err());
    assert_eq!(catalog.version(), version);
    assert_eq!(catalog.entry(id).unwrap().data().table_declarations[0].table_name.table_name.text(), "keep");
}

#[test]
fn lower_ranks_win_name_conflicts() {
    let mut catalog = Catalog::new();
    add(&mut catalog, 10, &tables_only(vec![table("", "main", "t", &["slow"])]));
    add(&mut catalog, 1, &tables_only(vec![table("", "main", "t", &["fast"])]));
    assert_eq!(resolve(&catalog, "select fast from t"), vec!["fast -> t.fast"]);
    let ranks: Vec<_> = catalog.entries_ranked().map(|(rank, _)| rank).collect();
    assert_eq!(ranks, vec![1, 10]);
}

#[test]
fn drop_removes_the_entry() {
    let mut catalog = Catalog::new();
    let id = add(&mut catalog, 0, &tables_only(vec![table("db", "main", "t", &["a"])]));
    let version = catalog.version();
    catalog.drop_descriptor(id).unwrap();
    assert!(!catalog.contains(id));
    assert!(catalog.version() > version);
    assert_eq!(resolve(&catalog, "select a from t"), vec!["a -> ?"]);

    // Dropping an unknown id is a no-op
    let version = catalog.version();
    catalog.drop_descriptor(id).unwrap();
    catalog.drop_descriptor(12345).unwrap();
    assert_eq!(catalog.version(), version);
}

#[test]
fn name_search_index_finds_substrings() {
    let mut catalog = Catalog::new();
    let id = add(&mut catalog, 0, &tables_only(vec![table("", "main", "customer_orders", &["order_id", "customer"])]));
    let entry = catalog.entry(id).unwrap();
    let index = entry.name_search_index();
    let found = |prefix: &str| -> Vec<String> {
        let mut names: Vec<_> = index.search(prefix.as_bytes()).map(|n| n.text.to_string()).collect();
        names.sort();
        names.dedup();
        names
    };
    assert_eq!(found("order"), vec!["customer_orders", "order_id"]);
    assert_eq!(found("CUST"), vec!["customer", "customer_orders"]);
    assert!(found("zzz").is_empty());
    // The index is built once
    assert!(std::ptr::eq(entry.name_search_index(), index));
    // customer occurs as a table prefix and as a column
    assert!(index.search(b"customer").all(|n| n.text.starts_with("customer")));
    assert!(!index.is_empty());
    assert_eq!(index.byte_size(), index.len() * 8);
}

#[test]
fn descriptors_are_described_with_their_schemas() {
    let mut catalog = Catalog::new();
    let id = add(&mut catalog, 7, &tables_only(vec![table("db", "main", "t", &["a", "b"]), table("db", "other", "u", &["c"])]));
    let described = catalog.describe_entries_of(id).unwrap().entries.unwrap();
    assert_eq!(described.len(), 1);
    let entry = &described[0];
    assert_eq!(entry.catalog_entry_id, id);
    assert_eq!(entry.catalog_entry_type, CatalogEntryType::DESCRIPTOR_POOL);
    assert_eq!(entry.rank, 7);
    let mut schemas: Vec<_> = entry.schemas.as_ref().unwrap().iter().collect();
    schemas.sort_by_key(|s| s.schema_name.clone());
    assert_eq!(schemas.len(), 2);
    assert_eq!(schemas[0].database_name.as_deref(), Some("db"));
    assert_eq!(schemas[0].schema_name.as_deref(), Some("main"));
    let tables = schemas[0].tables.as_ref().unwrap();
    assert_eq!(tables.len(), 1);
    assert_eq!(tables[0].table_name.as_deref(), Some("t"));
    let columns = tables[0].columns.as_ref().unwrap();
    assert_eq!(columns.iter().map(|c| c.column_name.clone().unwrap()).collect::<Vec<_>>(), vec!["a", "b"]);
    assert_eq!(columns.iter().map(|c| c.ordinal_position).collect::<Vec<_>>(), vec![0, 1]);
    assert_eq!(schemas[1].tables.as_ref().unwrap()[0].table_name.as_deref(), Some("u"));
}

#[test]
fn statistics_count_content_of_all_entries() {
    let mut catalog = Catalog::new();
    let empty = catalog.statistics().content.unwrap();
    assert_eq!((empty.database_count, empty.schema_count, empty.table_count, empty.table_column_count), (0, 0, 0, 0));

    add(&mut catalog, 0, &tables_only(vec![table("db", "main", "t", &["a", "b"]), table("db", "other", "u", &["c"])]));
    let mut script = Script::new(&catalog);
    script.insert_text_at(0, "create table db.main.s (x int, y int, z int)");
    script.analyze(&catalog, true).unwrap();
    catalog.load_script(script.analyzed.clone().unwrap(), 1).unwrap();

    let content = catalog.statistics().content.unwrap();
    assert_eq!(content.database_count, 1);
    assert_eq!(content.schema_count, 2);
    assert_eq!(content.table_count, 3);
    assert_eq!(content.table_column_count, 6);
}
