-- DashQL Connection Relations.
-- This file is auto-generated and can only be updated through a catalog refresh.
--
-- Catalog Source: HyperDB WASM pg_class
-- Last Refresh: 2026-09-01T13:03:34.029Z

-- DashQL Hyper Catalog Section: "hyper"
CREATE TABLE "hyper"."pg_catalog"."hyper_attached_database" (
    "database_name" VARCHAR,
    "database_alias" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."hyper_database" (
    "datname" VARCHAR,
    "last_file_write_timestamp" TIMESTAMP,
    "database_version" VARCHAR,
    "creation_hyper_version" VARCHAR,
    "encrypted" BOOLEAN,
    "workspace" VARCHAR,
    "owned" BOOLEAN,
    "type" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."hyper_event_logs" (
    "log_file_name" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."hyper_load" (
    "load" FLOAT,
    "scheduler_load" FLOAT,
    "memory_load" FLOAT,
    "machine_cpu_load" FLOAT,
    "workspace_load" FLOAT,
    "memory_buckets_load" FLOAT
);

CREATE TABLE "hyper"."pg_catalog"."hyper_memory_usage" (
    "timestamp" TIMESTAMP,
    "total_virtual_memory" INTEGER,
    "total_virtual_memory_used" INTEGER,
    "total_virtual_memory_process" INTEGER,
    "total_physical_memory" INTEGER,
    "total_physical_memory_used" INTEGER,
    "total_physical_memory_process" INTEGER,
    "total_memory_limit" INTEGER
);

CREATE TABLE "hyper"."pg_catalog"."hyper_thread_usage" (
    "total_threads_active" INTEGER,
    "total_threads_idle" INTEGER
);

CREATE TABLE "hyper"."pg_catalog"."hyper_threads" (
    "thread_id" INTEGER,
    "type" VARCHAR,
    "state" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_aggregate" (
    "aggfnoid" VARCHAR,
    "aggtransfn" VARCHAR,
    "aggfinalfn" VARCHAR,
    "aggsortop" VARCHAR,
    "aggtranstype" VARCHAR,
    "agginitval" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_am" (
    "amname" VARCHAR,
    "amstrategies" INTEGER,
    "amsupport" INTEGER,
    "amcanorder" BOOLEAN,
    "amcanorderbyop" BOOLEAN,
    "amcanbackward" BOOLEAN,
    "amcanunique" BOOLEAN,
    "amcanmulticol" BOOLEAN,
    "amoptionalkey" BOOLEAN,
    "amsearchnulls" BOOLEAN,
    "amstorage" BOOLEAN,
    "amclusterable" BOOLEAN,
    "ampredlocks" BOOLEAN,
    "amkeytype" VARCHAR,
    "aminsert" VARCHAR,
    "ambeginscan" VARCHAR,
    "amgettuple" VARCHAR,
    "amgetbitmap" VARCHAR,
    "amrescan" VARCHAR,
    "amendscan" VARCHAR,
    "ammarkpos" VARCHAR,
    "amrestrpos" VARCHAR,
    "ambuild" VARCHAR,
    "ambuildempty" VARCHAR,
    "ambulkdelete" VARCHAR,
    "amvacuumcleanup" VARCHAR,
    "amcostestimate" VARCHAR,
    "amoptions" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_amop" (
    "amopfamily" VARCHAR,
    "amoplefttype" VARCHAR,
    "amoprighttype" VARCHAR,
    "amopstrategy" INTEGER,
    "amoppurpose" VARCHAR,
    "amopopr" VARCHAR,
    "amopmethod" VARCHAR,
    "amopsortfamily" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_amproc" (
    "amprocfamily" VARCHAR,
    "amproclefttype" VARCHAR,
    "amprocrighttype" VARCHAR,
    "amprocnum" INTEGER,
    "amproc" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_attrdef" (
    "adrelid" VARCHAR,
    "adnum" INTEGER,
    "adbin" VARCHAR,
    "adsrc" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_attribute" (
    "attrelid" VARCHAR,
    "attname" VARCHAR,
    "atttypid" VARCHAR,
    "attstattarget" INTEGER,
    "attlen" INTEGER,
    "attnum" INTEGER,
    "attndims" INTEGER,
    "attcacheoff" INTEGER,
    "atttypmod" INTEGER,
    "attbyval" BOOLEAN,
    "attstorage" VARCHAR,
    "attalign" VARCHAR,
    "attnotnull" BOOLEAN,
    "atthasdef" BOOLEAN,
    "attisdropped" BOOLEAN,
    "attislocal" BOOLEAN,
    "attinhcount" INTEGER,
    "attcollation" VARCHAR,
    "attacl" VARCHAR,
    "attoptions" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_auth_members" (
    "roleid" VARCHAR,
    "member" VARCHAR,
    "grantor" VARCHAR,
    "admin_option" BOOLEAN
);

CREATE TABLE "hyper"."pg_catalog"."pg_authid" (
    "rolname" VARCHAR,
    "rolsuper" BOOLEAN,
    "rolinherit" BOOLEAN,
    "rolcreaterole" BOOLEAN,
    "rolcreatedb" BOOLEAN,
    "rolcatupdate" BOOLEAN,
    "rolcanlogin" BOOLEAN,
    "rolreplication" BOOLEAN,
    "rolconnlimit" INTEGER,
    "rolpassword" VARCHAR,
    "rolvaliduntil" TIMESTAMP
);

CREATE TABLE "hyper"."pg_catalog"."pg_available_extension_versions" (
    "name" VARCHAR,
    "version" VARCHAR,
    "installed" BOOLEAN,
    "superuser" BOOLEAN,
    "relocatable" BOOLEAN,
    "schema" VARCHAR,
    "requires" VARCHAR,
    "comment" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_available_extensions" (
    "name" VARCHAR,
    "default_version" VARCHAR,
    "installed_version" VARCHAR,
    "comment" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_cast" (
    "castsource" VARCHAR,
    "casttarget" VARCHAR,
    "castfunc" VARCHAR,
    "castcontext" VARCHAR,
    "castmethod" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_class" (
    "relname" VARCHAR,
    "relnamespace" VARCHAR,
    "reltype" VARCHAR,
    "reloftype" VARCHAR,
    "relowner" VARCHAR,
    "relam" VARCHAR,
    "relfilenode" VARCHAR,
    "reltablespace" VARCHAR,
    "relpages" INTEGER,
    "reltuples" FLOAT,
    "reltoastrelid" VARCHAR,
    "reltoastidxid" VARCHAR,
    "relhasindex" BOOLEAN,
    "relisshared" BOOLEAN,
    "relpersistence" VARCHAR,
    "relkind" VARCHAR,
    "relnatts" INTEGER,
    "relchecks" INTEGER,
    "relhasoids" BOOLEAN,
    "relhaspkey" BOOLEAN,
    "relhasrules" BOOLEAN,
    "relhastriggers" BOOLEAN,
    "relhassubclass" BOOLEAN,
    "relfrozenxid" INTEGER,
    "relacl" VARCHAR,
    "reloptions" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_collation" (
    "collname" VARCHAR,
    "collnamespace" VARCHAR,
    "collowner" VARCHAR,
    "collencoding" INTEGER,
    "collcollate" VARCHAR,
    "collctype" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_constraint" (
    "conname" VARCHAR,
    "connamespace" VARCHAR,
    "contype" VARCHAR,
    "condeferrable" BOOLEAN,
    "condeferred" BOOLEAN,
    "convalidated" BOOLEAN,
    "conrelid" VARCHAR,
    "contypid" VARCHAR,
    "conindid" VARCHAR,
    "confrelid" VARCHAR,
    "confupdtype" VARCHAR,
    "confdeltype" VARCHAR,
    "confmatchtype" VARCHAR,
    "conislocal" BOOLEAN,
    "coninhcount" INTEGER,
    "conkey" INTEGER,
    "confkey" INTEGER,
    "conpfeqop" VARCHAR,
    "conppeqop" VARCHAR,
    "conffeqop" VARCHAR,
    "conexclop" VARCHAR,
    "conbin" VARCHAR,
    "consrc" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_conversion" (
    "conname" VARCHAR,
    "connamespace" VARCHAR,
    "conowner" VARCHAR,
    "conforencoding" INTEGER,
    "contoencoding" INTEGER,
    "conproc" VARCHAR,
    "condefault" BOOLEAN
);

CREATE TABLE "hyper"."pg_catalog"."pg_cursors" (
    "name" VARCHAR,
    "statement" VARCHAR,
    "is_holdable" BOOLEAN,
    "is_binary" BOOLEAN,
    "is_scrollable" BOOLEAN,
    "creation_time" TIMESTAMP
);

CREATE TABLE "hyper"."pg_catalog"."pg_database" (
    "datname" VARCHAR,
    "datdba" VARCHAR,
    "encoding" INTEGER,
    "datcollate" VARCHAR,
    "datctype" VARCHAR,
    "datistemplate" BOOLEAN,
    "datallowconn" BOOLEAN,
    "datconnlimit" INTEGER,
    "datlastsysoid" VARCHAR,
    "datfrozenxid" INTEGER,
    "dattablespace" VARCHAR,
    "datacl" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_db_role_setting" (
    "setdatabase" VARCHAR,
    "setrole" VARCHAR,
    "setconfig" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_default_acl" (
    "defaclrole" VARCHAR,
    "defaclnamespace" VARCHAR,
    "defaclobjtype" VARCHAR,
    "defaclacl" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_depend" (
    "classid" VARCHAR,
    "objid" VARCHAR,
    "objsubid" INTEGER,
    "refclassid" VARCHAR,
    "refobjid" VARCHAR,
    "refobjsubid" INTEGER,
    "deptype" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_description" (
    "objoid" VARCHAR,
    "classoid" VARCHAR,
    "objsubid" INTEGER,
    "description" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_enum" (
    "enumtypid" VARCHAR,
    "enumsortorder" FLOAT,
    "enumlabel" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_extension" (
    "extname" VARCHAR,
    "extowner" VARCHAR,
    "extnamespace" VARCHAR,
    "extrelocatable" BOOLEAN,
    "extversion" VARCHAR,
    "extconfig" VARCHAR,
    "extcondition" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_foreign_data_wrapper" (
    "fdwname" VARCHAR,
    "fdwowner" VARCHAR,
    "fdwhandler" VARCHAR,
    "fdwvalidator" VARCHAR,
    "fdwacl" VARCHAR,
    "fdwoptions" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_foreign_server" (
    "srvname" VARCHAR,
    "srvowner" VARCHAR,
    "srvfdw" VARCHAR,
    "srvtype" VARCHAR,
    "srvversion" VARCHAR,
    "srvacl" VARCHAR,
    "srvoptions" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_foreign_table" (
    "ftrelid" VARCHAR,
    "ftserver" VARCHAR,
    "ftoptions" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_group" (
    "groname" VARCHAR,
    "grosysid" VARCHAR,
    "grolist" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_index" (
    "indexrelid" VARCHAR,
    "indrelid" VARCHAR,
    "indnatts" INTEGER,
    "indisunique" BOOLEAN,
    "indisprimary" BOOLEAN,
    "indisexclusion" BOOLEAN,
    "indimmediate" BOOLEAN,
    "indisclustered" BOOLEAN,
    "indisvalid" BOOLEAN,
    "indcheckxmin" BOOLEAN,
    "indisready" BOOLEAN,
    "indkey" INTEGER,
    "indcollation" VARCHAR,
    "indclass" VARCHAR,
    "indoption" INTEGER,
    "indexprs" VARCHAR,
    "indpred" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_indexes" (
    "schemaname" VARCHAR,
    "tablename" VARCHAR,
    "indexname" VARCHAR,
    "tablespace" VARCHAR,
    "indexdef" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_inherits" (
    "inhrelid" VARCHAR,
    "inhparent" VARCHAR,
    "inhseqno" INTEGER
);

CREATE TABLE "hyper"."pg_catalog"."pg_language" (
    "lanname" VARCHAR,
    "lanowner" VARCHAR,
    "lanispl" BOOLEAN,
    "lanpltrusted" BOOLEAN,
    "lanplcallfoid" VARCHAR,
    "laninline" VARCHAR,
    "lanvalidator" VARCHAR,
    "lanacl" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_largeobject" (
    "loid" VARCHAR,
    "pageno" INTEGER,
    "data" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_largeobject_metadata" (
    "lomowner" VARCHAR,
    "lomacl" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_locks" (
    "locktype" VARCHAR,
    "database" VARCHAR,
    "relation" VARCHAR,
    "page" INTEGER,
    "tuple" INTEGER,
    "virtualxid" VARCHAR,
    "transactionid" INTEGER,
    "classid" VARCHAR,
    "objid" VARCHAR,
    "objsubid" INTEGER,
    "virtualtransaction" VARCHAR,
    "pid" INTEGER,
    "mode" VARCHAR,
    "granted" BOOLEAN
);

CREATE TABLE "hyper"."pg_catalog"."pg_namespace" (
    "nspname" VARCHAR,
    "nspowner" VARCHAR,
    "nspacl" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_opclass" (
    "opcmethod" VARCHAR,
    "opcname" VARCHAR,
    "opcnamespace" VARCHAR,
    "opcowner" VARCHAR,
    "opcfamily" VARCHAR,
    "opcintype" VARCHAR,
    "opcdefault" BOOLEAN,
    "opckeytype" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_operator" (
    "oprname" VARCHAR,
    "oprnamespace" VARCHAR,
    "oprowner" VARCHAR,
    "oprkind" VARCHAR,
    "oprcanmerge" BOOLEAN,
    "oprcanhash" BOOLEAN,
    "oprleft" VARCHAR,
    "oprright" VARCHAR,
    "oprresult" VARCHAR,
    "oprcom" VARCHAR,
    "oprnegate" VARCHAR,
    "oprcode" VARCHAR,
    "oprrest" VARCHAR,
    "oprjoin" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_opfamily" (
    "opfmethod" VARCHAR,
    "opfname" VARCHAR,
    "opfnamespace" VARCHAR,
    "opfowner" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_pltemplate" (
    "tmplname" VARCHAR,
    "tmpltrusted" BOOLEAN,
    "tmpldbacreate" BOOLEAN,
    "tmplhandler" VARCHAR,
    "tmplinline" VARCHAR,
    "tmplvalidator" VARCHAR,
    "tmpllibrary" VARCHAR,
    "tmplacl" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_prepared_statements" (
    "name" VARCHAR,
    "statement" VARCHAR,
    "prepare_time" TIMESTAMP,
    "parameter_types" VARCHAR,
    "from_sql" BOOLEAN
);

CREATE TABLE "hyper"."pg_catalog"."pg_prepared_xacts" (
    "transaction" INTEGER,
    "gid" VARCHAR,
    "prepared" TIMESTAMP,
    "owner" VARCHAR,
    "database" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_proc" (
    "proname" VARCHAR,
    "pronamespace" VARCHAR,
    "proowner" VARCHAR,
    "prolang" VARCHAR,
    "procost" FLOAT,
    "prorows" FLOAT,
    "provariadic" VARCHAR,
    "prosupport" VARCHAR,
    "prokind" VARCHAR,
    "prosecdef" BOOLEAN,
    "proleakproof" BOOLEAN,
    "proisstrict" BOOLEAN,
    "proretset" BOOLEAN,
    "provolatile" VARCHAR,
    "proparallel" VARCHAR,
    "pronargs" INTEGER,
    "pronargdefaults" INTEGER,
    "prorettype" VARCHAR,
    "proargtypes" VARCHAR,
    "proallargtypes" VARCHAR,
    "proargmodes" VARCHAR,
    "proargnames" VARCHAR,
    "proargdefaults" VARCHAR,
    "protrftypes" VARCHAR,
    "prosrc" VARCHAR,
    "probin" VARCHAR,
    "prosqlbody" VARCHAR,
    "proconfig" VARCHAR,
    "proacl" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_rewrite" (
    "rulename" VARCHAR,
    "ev_class" VARCHAR,
    "ev_attr" INTEGER,
    "ev_type" VARCHAR,
    "ev_enabled" VARCHAR,
    "is_instead" BOOLEAN,
    "ev_qual" VARCHAR,
    "ev_action" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_roles" (
    "rolname" VARCHAR,
    "rolsuper" BOOLEAN,
    "rolinherit" BOOLEAN,
    "rolcreaterole" BOOLEAN,
    "rolcreatedb" BOOLEAN,
    "rolcatupdate" BOOLEAN,
    "rolcanlogin" BOOLEAN,
    "rolreplication" BOOLEAN,
    "rolconnlimit" INTEGER,
    "rolpassword" VARCHAR,
    "rolvaliduntil" TIMESTAMP,
    "rolconfig" VARCHAR,
    "oid" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_rules" (
    "schemaname" VARCHAR,
    "tablename" VARCHAR,
    "rulename" VARCHAR,
    "definition" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_seclabel" (
    "objoid" VARCHAR,
    "classoid" VARCHAR,
    "objsubid" INTEGER,
    "provider" VARCHAR,
    "label" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_seclabels" (
    "objoid" VARCHAR,
    "classoid" VARCHAR,
    "objsubid" INTEGER,
    "objtype" VARCHAR,
    "objnamespace" VARCHAR,
    "objname" VARCHAR,
    "provider" VARCHAR,
    "label" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_settings" (
    "name" VARCHAR,
    "setting" VARCHAR,
    "unit" VARCHAR,
    "category" VARCHAR,
    "short_desc" VARCHAR,
    "extra_desc" VARCHAR,
    "context" VARCHAR,
    "vartype" VARCHAR,
    "source" VARCHAR,
    "min_val" VARCHAR,
    "max_val" VARCHAR,
    "enumvals" VARCHAR,
    "boot_val" VARCHAR,
    "reset_val" VARCHAR,
    "sourcefile" VARCHAR,
    "sourceline" INTEGER
);

CREATE TABLE "hyper"."pg_catalog"."pg_shadow" (
    "usename" VARCHAR,
    "usesysid" VARCHAR,
    "usecreatedb" BOOLEAN,
    "usesuper" BOOLEAN,
    "usecatupd" BOOLEAN,
    "passwd" VARCHAR,
    "valuntil" TIMESTAMP,
    "useconfig" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_shdepend" (
    "dbid" VARCHAR,
    "classid" VARCHAR,
    "objid" VARCHAR,
    "objsubid" INTEGER,
    "refclassid" VARCHAR,
    "refobjid" VARCHAR,
    "deptype" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_shdescription" (
    "objoid" VARCHAR,
    "classoid" VARCHAR,
    "description" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_stat_activity" (
    "datid" VARCHAR,
    "datname" VARCHAR,
    "procpid" INTEGER,
    "usesysid" VARCHAR,
    "usename" VARCHAR,
    "application_name" VARCHAR,
    "client_addr" VARCHAR,
    "client_hostname" VARCHAR,
    "client_port" INTEGER,
    "backend_start" TIMESTAMP,
    "xact_start" TIMESTAMP,
    "query_start" TIMESTAMP,
    "state_change" TIMESTAMP,
    "waiting" BOOLEAN,
    "state" VARCHAR,
    "backend_xid" INTEGER,
    "backend_xmin" INTEGER,
    "current_query" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_stat_all_indexes" (
    "relid" VARCHAR,
    "indexrelid" VARCHAR,
    "schemaname" VARCHAR,
    "relname" VARCHAR,
    "indexrelname" VARCHAR,
    "idx_scan" INTEGER,
    "idx_tup_read" INTEGER,
    "idx_tup_fetch" INTEGER
);

CREATE TABLE "hyper"."pg_catalog"."pg_stat_all_tables" (
    "relid" VARCHAR,
    "schemaname" VARCHAR,
    "relname" VARCHAR,
    "seq_scan" INTEGER,
    "seq_tup_read" INTEGER,
    "idx_scan" INTEGER,
    "idx_tup_fetch" INTEGER,
    "n_tup_ins" INTEGER,
    "n_tup_upd" INTEGER,
    "n_tup_del" INTEGER,
    "n_tup_hot_upd" INTEGER,
    "n_live_tup" INTEGER,
    "n_dead_tup" INTEGER,
    "n_mod_since_analyze" INTEGER,
    "last_vacuum" TIMESTAMP,
    "last_autovacuum" TIMESTAMP,
    "last_analyze" TIMESTAMP,
    "last_autoanalyze" TIMESTAMP,
    "vacuum_count" INTEGER,
    "autovacuum_count" INTEGER,
    "analyze_count" INTEGER,
    "autoanalyze_count" INTEGER
);

CREATE TABLE "hyper"."pg_catalog"."pg_stat_bgwriter" (
    "checkpoints_timed" INTEGER,
    "checkpoints_req" INTEGER,
    "checkpoint_write_time" FLOAT,
    "checkpoint_sync_time" FLOAT,
    "buffers_checkpoint" INTEGER,
    "buffers_clean" INTEGER,
    "maxwritten_clean" INTEGER,
    "buffers_backend" INTEGER,
    "buffers_backend_fsync" INTEGER,
    "buffers_alloc" INTEGER,
    "stats_reset" TIMESTAMP
);

CREATE TABLE "hyper"."pg_catalog"."pg_stat_database" (
    "datid" VARCHAR,
    "datname" VARCHAR,
    "numbackends" INTEGER,
    "xact_commit" INTEGER,
    "xact_rollback" INTEGER,
    "blks_read" INTEGER,
    "blks_hit" INTEGER,
    "tup_returned" INTEGER,
    "tup_fetched" INTEGER,
    "tup_inserted" INTEGER,
    "tup_updated" INTEGER,
    "tup_deleted" INTEGER,
    "conflicts" INTEGER,
    "temp_files" INTEGER,
    "temp_bytes" INTEGER,
    "deadlocks" INTEGER,
    "blk_read_time" FLOAT,
    "blk_write_time" FLOAT,
    "stats_reset" TIMESTAMP
);

CREATE TABLE "hyper"."pg_catalog"."pg_stat_database_conflicts" (
    "datid" VARCHAR,
    "datname" VARCHAR,
    "confl_tablespace" INTEGER,
    "confl_lock" INTEGER,
    "confl_snapshot" INTEGER,
    "confl_bufferpin" INTEGER,
    "confl_deadlock" INTEGER
);

CREATE TABLE "hyper"."pg_catalog"."pg_stat_replication" (
    "procpid" INTEGER,
    "usesysid" VARCHAR,
    "usename" VARCHAR,
    "application_name" VARCHAR,
    "client_addr" VARCHAR,
    "client_hostname" VARCHAR,
    "client_port" INTEGER,
    "backend_start" TIMESTAMP,
    "backend_xmin" INTEGER,
    "state" VARCHAR,
    "sent_location" INTEGER,
    "write_location" INTEGER,
    "flush_location" INTEGER,
    "replay_location" INTEGER,
    "sync_priority" INTEGER,
    "sync_state" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_stat_sys_indexes" (
    "relid" VARCHAR,
    "indexrelid" VARCHAR,
    "schemaname" VARCHAR,
    "relname" VARCHAR,
    "indexrelname" VARCHAR,
    "idx_scan" INTEGER,
    "idx_tup_read" INTEGER,
    "idx_tup_fetch" INTEGER
);

CREATE TABLE "hyper"."pg_catalog"."pg_stat_sys_tables" (
    "relid" VARCHAR,
    "schemaname" VARCHAR,
    "relname" VARCHAR,
    "seq_scan" INTEGER,
    "seq_tup_read" INTEGER,
    "idx_scan" INTEGER,
    "idx_tup_fetch" INTEGER,
    "n_tup_ins" INTEGER,
    "n_tup_upd" INTEGER,
    "n_tup_del" INTEGER,
    "n_tup_hot_upd" INTEGER,
    "n_live_tup" INTEGER,
    "n_dead_tup" INTEGER,
    "n_mod_since_analyze" INTEGER,
    "last_vacuum" TIMESTAMP,
    "last_autovacuum" TIMESTAMP,
    "last_analyze" TIMESTAMP,
    "last_autoanalyze" TIMESTAMP,
    "vacuum_count" INTEGER,
    "autovacuum_count" INTEGER,
    "analyze_count" INTEGER,
    "autoanalyze_count" INTEGER
);

CREATE TABLE "hyper"."pg_catalog"."pg_stat_user_functions" (
    "funcid" VARCHAR,
    "schemaname" VARCHAR,
    "funcname" VARCHAR,
    "calls" INTEGER,
    "total_time" FLOAT,
    "self_time" FLOAT
);

CREATE TABLE "hyper"."pg_catalog"."pg_stat_user_indexes" (
    "relid" VARCHAR,
    "indexrelid" VARCHAR,
    "schemaname" VARCHAR,
    "relname" VARCHAR,
    "indexrelname" VARCHAR,
    "idx_scan" INTEGER,
    "idx_tup_read" INTEGER,
    "idx_tup_fetch" INTEGER
);

CREATE TABLE "hyper"."pg_catalog"."pg_stat_user_tables" (
    "relid" VARCHAR,
    "schemaname" VARCHAR,
    "relname" VARCHAR,
    "seq_scan" INTEGER,
    "seq_tup_read" INTEGER,
    "idx_scan" INTEGER,
    "idx_tup_fetch" INTEGER,
    "n_tup_ins" INTEGER,
    "n_tup_upd" INTEGER,
    "n_tup_del" INTEGER,
    "n_tup_hot_upd" INTEGER,
    "n_live_tup" INTEGER,
    "n_dead_tup" INTEGER,
    "n_mod_since_analyze" INTEGER,
    "last_vacuum" TIMESTAMP,
    "last_autovacuum" TIMESTAMP,
    "last_analyze" TIMESTAMP,
    "last_autoanalyze" TIMESTAMP,
    "vacuum_count" INTEGER,
    "autovacuum_count" INTEGER,
    "analyze_count" INTEGER,
    "autoanalyze_count" INTEGER
);

CREATE TABLE "hyper"."pg_catalog"."pg_stat_xact_all_tables" (
    "relid" VARCHAR,
    "schemaname" VARCHAR,
    "relname" VARCHAR,
    "seq_scan" INTEGER,
    "seq_tup_read" INTEGER,
    "idx_scan" INTEGER,
    "idx_tup_fetch" INTEGER,
    "n_tup_ins" INTEGER,
    "n_tup_upd" INTEGER,
    "n_tup_del" INTEGER,
    "n_tup_hot_upd" INTEGER
);

CREATE TABLE "hyper"."pg_catalog"."pg_stat_xact_sys_tables" (
    "relid" VARCHAR,
    "schemaname" VARCHAR,
    "relname" VARCHAR,
    "seq_scan" INTEGER,
    "seq_tup_read" INTEGER,
    "idx_scan" INTEGER,
    "idx_tup_fetch" INTEGER,
    "n_tup_ins" INTEGER,
    "n_tup_upd" INTEGER,
    "n_tup_del" INTEGER,
    "n_tup_hot_upd" INTEGER
);

CREATE TABLE "hyper"."pg_catalog"."pg_stat_xact_user_functions" (
    "funcid" VARCHAR,
    "schemaname" VARCHAR,
    "funcname" VARCHAR,
    "calls" INTEGER,
    "total_time" FLOAT,
    "self_time" FLOAT
);

CREATE TABLE "hyper"."pg_catalog"."pg_stat_xact_user_tables" (
    "relid" VARCHAR,
    "schemaname" VARCHAR,
    "relname" VARCHAR,
    "seq_scan" INTEGER,
    "seq_tup_read" INTEGER,
    "idx_scan" INTEGER,
    "idx_tup_fetch" INTEGER,
    "n_tup_ins" INTEGER,
    "n_tup_upd" INTEGER,
    "n_tup_del" INTEGER,
    "n_tup_hot_upd" INTEGER
);

CREATE TABLE "hyper"."pg_catalog"."pg_statio_all_sequences" (
    "relid" VARCHAR,
    "schemaname" VARCHAR,
    "relname" VARCHAR,
    "blks_read" INTEGER,
    "blks_hit" INTEGER
);

CREATE TABLE "hyper"."pg_catalog"."pg_statio_all_tables" (
    "relid" VARCHAR,
    "schemaname" VARCHAR,
    "relname" VARCHAR,
    "heap_blks_read" INTEGER,
    "heap_blks_hit" INTEGER,
    "idx_blks_read" INTEGER,
    "idx_blks_hit" INTEGER,
    "toast_blks_read" INTEGER,
    "toast_blks_hit" INTEGER,
    "tidx_blks_read" INTEGER,
    "tidx_blks_hit" INTEGER
);

CREATE TABLE "hyper"."pg_catalog"."pg_statio_sys_indexes" (
    "relid" VARCHAR,
    "indexrelid" VARCHAR,
    "schemaname" VARCHAR,
    "relname" VARCHAR,
    "indexrelname" VARCHAR,
    "idx_blks_read" INTEGER,
    "idx_blks_hit" INTEGER
);

CREATE TABLE "hyper"."pg_catalog"."pg_statio_sys_sequences" (
    "relid" VARCHAR,
    "schemaname" VARCHAR,
    "relname" VARCHAR,
    "blks_read" INTEGER,
    "blks_hit" INTEGER
);

CREATE TABLE "hyper"."pg_catalog"."pg_statio_sys_tables" (
    "relid" VARCHAR,
    "schemaname" VARCHAR,
    "relname" VARCHAR,
    "heap_blks_read" INTEGER,
    "heap_blks_hit" INTEGER,
    "idx_blks_read" INTEGER,
    "idx_blks_hit" INTEGER,
    "toast_blks_read" INTEGER,
    "toast_blks_hit" INTEGER,
    "tidx_blks_read" INTEGER,
    "tidx_blks_hit" INTEGER
);

CREATE TABLE "hyper"."pg_catalog"."pg_statio_user_indexes" (
    "relid" VARCHAR,
    "indexrelid" VARCHAR,
    "schemaname" VARCHAR,
    "relname" VARCHAR,
    "indexrelname" VARCHAR,
    "idx_blks_read" INTEGER,
    "idx_blks_hit" INTEGER
);

CREATE TABLE "hyper"."pg_catalog"."pg_statio_user_sequences" (
    "relid" VARCHAR,
    "schemaname" VARCHAR,
    "relname" VARCHAR,
    "blks_read" INTEGER,
    "blks_hit" INTEGER
);

CREATE TABLE "hyper"."pg_catalog"."pg_statio_user_tables" (
    "relid" VARCHAR,
    "schemaname" VARCHAR,
    "relname" VARCHAR,
    "heap_blks_read" INTEGER,
    "heap_blks_hit" INTEGER,
    "idx_blks_read" INTEGER,
    "idx_blks_hit" INTEGER,
    "toast_blks_read" INTEGER,
    "toast_blks_hit" INTEGER,
    "tidx_blks_read" INTEGER,
    "tidx_blks_hit" INTEGER
);

CREATE TABLE "hyper"."pg_catalog"."pg_statioio_all_indexes" (
    "relid" VARCHAR,
    "indexrelid" VARCHAR,
    "schemaname" VARCHAR,
    "relname" VARCHAR,
    "indexrelname" VARCHAR,
    "idx_blks_read" INTEGER,
    "idx_blks_hit" INTEGER
);

CREATE TABLE "hyper"."pg_catalog"."pg_statistic" (
    "starelid" VARCHAR,
    "staattnum" INTEGER,
    "stainherit" BOOLEAN,
    "stanullfrac" FLOAT,
    "stawidth" INTEGER,
    "stadistinct" FLOAT,
    "stakind1" INTEGER,
    "stakind2" INTEGER,
    "stakind3" INTEGER,
    "stakind4" INTEGER,
    "stakind5" INTEGER,
    "staop1" VARCHAR,
    "staop2" VARCHAR,
    "staop3" VARCHAR,
    "staop4" VARCHAR,
    "staop5" VARCHAR,
    "stanumbers1" FLOAT,
    "stanumbers2" FLOAT,
    "stanumbers3" FLOAT,
    "stanumbers4" FLOAT,
    "stanumbers5" FLOAT,
    "stavalues1" VARCHAR,
    "stavalues2" VARCHAR,
    "stavalues3" VARCHAR,
    "stavalues4" VARCHAR,
    "stavalues5" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_stats" (
    "schemaname" VARCHAR,
    "tablename" VARCHAR,
    "attname" VARCHAR,
    "inherited" BOOLEAN,
    "null_frac" FLOAT,
    "avg_width" INTEGER,
    "n_distinct" FLOAT,
    "most_common_vals" VARCHAR,
    "most_common_freqs" FLOAT,
    "histogram_bounds" VARCHAR,
    "correlation" FLOAT
);

CREATE TABLE "hyper"."pg_catalog"."pg_tables" (
    "schemaname" VARCHAR,
    "tablename" VARCHAR,
    "tableowner" VARCHAR,
    "tablespace" VARCHAR,
    "hasindexes" BOOLEAN,
    "hasrules" BOOLEAN,
    "hastriggers" BOOLEAN
);

CREATE TABLE "hyper"."pg_catalog"."pg_tablespace" (
    "spcname" VARCHAR,
    "spcowner" VARCHAR,
    "spclocation" VARCHAR,
    "spcacl" VARCHAR,
    "spcoptions" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_timezone_abbrevs" (
    "abbrev" VARCHAR,
    "utc_offset" INTEGER,
    "is_dst" BOOLEAN
);

CREATE TABLE "hyper"."pg_catalog"."pg_timezone_names" (
    "name" VARCHAR,
    "abbrev" VARCHAR,
    "utc_offset" INTEGER,
    "is_dst" BOOLEAN
);

CREATE TABLE "hyper"."pg_catalog"."pg_trigger" (
    "tgrelid" VARCHAR,
    "tgname" VARCHAR,
    "tgfoid" VARCHAR,
    "tgtype" INTEGER,
    "tgenabled" VARCHAR,
    "tgisinternal" BOOLEAN,
    "tgconstrrelid" VARCHAR,
    "tgconstrindid" VARCHAR,
    "tgconstraint" VARCHAR,
    "tgdeferrable" BOOLEAN,
    "tginitdeferred" BOOLEAN,
    "tgnargs" INTEGER,
    "tgattr" INTEGER,
    "tgargs" VARCHAR,
    "tgqual" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_ts_config" (
    "cfgname" VARCHAR,
    "cfgnamespace" VARCHAR,
    "cfgowner" VARCHAR,
    "cfgparser" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_ts_config_map" (
    "mapcfg" VARCHAR,
    "maptokentype" INTEGER,
    "mapseqno" INTEGER,
    "mapdict" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_ts_dict" (
    "dictname" VARCHAR,
    "dictnamespace" VARCHAR,
    "dictowner" VARCHAR,
    "dicttemplate" VARCHAR,
    "dictinitoption" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_ts_parser" (
    "prsname" VARCHAR,
    "prsnamespace" VARCHAR,
    "prsstart" VARCHAR,
    "prstoken" VARCHAR,
    "prsend" VARCHAR,
    "prsheadline" VARCHAR,
    "prslextype" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_ts_template" (
    "tmplname" VARCHAR,
    "tmplnamespace" VARCHAR,
    "tmplinit" VARCHAR,
    "tmpllexize" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_type" (
    "typname" VARCHAR,
    "typnamespace" VARCHAR,
    "typowner" VARCHAR,
    "typlen" INTEGER,
    "typbyval" BOOLEAN,
    "typtype" VARCHAR,
    "typcategory" VARCHAR,
    "typispreferred" BOOLEAN,
    "typisdefined" BOOLEAN,
    "typdelim" VARCHAR,
    "typrelid" VARCHAR,
    "typelem" VARCHAR,
    "typarray" VARCHAR,
    "typinput" VARCHAR,
    "typoutput" VARCHAR,
    "typreceive" VARCHAR,
    "typsend" VARCHAR,
    "typmodin" VARCHAR,
    "typmodout" VARCHAR,
    "typanalyze" VARCHAR,
    "typalign" VARCHAR,
    "typstorage" VARCHAR,
    "typnotnull" BOOLEAN,
    "typbasetype" VARCHAR,
    "typtypmod" INTEGER,
    "typndims" INTEGER,
    "typcollation" VARCHAR,
    "typdefaultbin" VARCHAR,
    "typdefault" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_user" (
    "usename" VARCHAR,
    "usesysid" VARCHAR,
    "usecreatedb" BOOLEAN,
    "usesuper" BOOLEAN,
    "usecatupd" BOOLEAN,
    "userepl" BOOLEAN,
    "passwd" VARCHAR,
    "valuntil" TIMESTAMP,
    "useconfig" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_user_mapping" (
    "umuser" VARCHAR,
    "umserver" VARCHAR,
    "umoptions" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_user_mappings" (
    "umid" VARCHAR,
    "srvid" VARCHAR,
    "srvname" VARCHAR,
    "umuser" VARCHAR,
    "usename" VARCHAR,
    "umoptions" VARCHAR
);

CREATE TABLE "hyper"."pg_catalog"."pg_views" (
    "schemaname" VARCHAR,
    "viewname" VARCHAR,
    "viewowner" VARCHAR,
    "definition" VARCHAR
);

CREATE TABLE "hyper"."public"."customer" (
    "c_custkey" INTEGER,
    "c_name" VARCHAR,
    "c_address" VARCHAR,
    "c_nationkey" INTEGER,
    "c_phone" VARCHAR,
    "c_acctbal" FLOAT,
    "c_mktsegment" VARCHAR,
    "c_comment" VARCHAR
);

CREATE TABLE "hyper"."public"."customers" (
    "c_custkey" INTEGER,
    "c_name" VARCHAR,
    "c_address" VARCHAR,
    "c_nationkey" INTEGER,
    "c_phone" VARCHAR,
    "c_acctbal" FLOAT,
    "c_mktsegment" VARCHAR,
    "c_comment" VARCHAR
);

CREATE TABLE "hyper"."public"."lineitem" (
    "l_orderkey" INTEGER,
    "l_partkey" INTEGER,
    "l_suppkey" INTEGER,
    "l_linenumber" INTEGER,
    "l_quantity" FLOAT,
    "l_extendedprice" FLOAT,
    "l_discount" FLOAT,
    "l_tax" FLOAT,
    "l_returnflag" VARCHAR,
    "l_linestatus" VARCHAR,
    "l_shipdate" DATE,
    "l_commitdate" DATE,
    "l_receiptdate" DATE,
    "l_shipinstruct" VARCHAR,
    "l_shipmode" VARCHAR,
    "l_comment" VARCHAR
);

CREATE TABLE "hyper"."public"."nation" (
    "n_nationkey" INTEGER,
    "n_name" VARCHAR,
    "n_regionkey" INTEGER,
    "n_comment" VARCHAR
);

CREATE TABLE "hyper"."public"."orders" (
    "o_orderkey" INTEGER,
    "o_custkey" INTEGER,
    "o_orderstatus" VARCHAR,
    "o_totalprice" FLOAT,
    "o_orderdate" DATE,
    "o_orderpriority" VARCHAR,
    "o_clerk" VARCHAR,
    "o_shippriority" INTEGER,
    "o_comment" VARCHAR
);

CREATE TABLE "hyper"."public"."part" (
    "p_partkey" INTEGER,
    "p_name" VARCHAR,
    "p_mfgr" VARCHAR,
    "p_brand" VARCHAR,
    "p_type" VARCHAR,
    "p_size" INTEGER,
    "p_container" VARCHAR,
    "p_retailprice" FLOAT,
    "p_comment" VARCHAR
);

CREATE TABLE "hyper"."public"."partsupp" (
    "ps_partkey" INTEGER,
    "ps_suppkey" INTEGER,
    "ps_availqty" INTEGER,
    "ps_supplycost" FLOAT,
    "ps_comment" VARCHAR
);

CREATE TABLE "hyper"."public"."region" (
    "r_regionkey" INTEGER,
    "r_name" VARCHAR,
    "r_comment" VARCHAR
);

CREATE TABLE "hyper"."public"."supplier" (
    "s_suppkey" INTEGER,
    "s_name" VARCHAR,
    "s_address" VARCHAR,
    "s_nationkey" INTEGER,
    "s_phone" VARCHAR,
    "s_acctbal" FLOAT,
    "s_comment" VARCHAR
);
-- DashQL Hyper Catalog Section End
