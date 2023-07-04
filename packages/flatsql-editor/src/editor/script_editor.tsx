import * as React from 'react';
import * as flatsql from '@ankoh/flatsql';
import AutoSizer from 'react-virtualized-auto-sizer';
import cn from 'classnames';

import { useBackend, useBackendResolver } from '../backend';
import { CodeMirror } from './codemirror';
import { FlatSQLEditor } from './editor_plugin';
import { EditorContext } from './editor_context';

import iconMainScript from '../../static/svg/icons/database_search.svg';
import iconExternalScript from '../../static/svg/icons/tables_connected.svg';
import iconLoadExample from '../../static/svg/icons/folder_open.svg';
import iconAccount from '../../static/svg/icons/account_circle.svg';

import styles from './script_editor.module.css';

interface Props {}

const TMP_TPCH_SCHEMA = `create table part (
   p_partkey integer not null,
   p_name varchar(55) not null,
   p_mfgr char(25) not null,
   p_brand char(10) not null,
   p_type varchar(25) not null,
   p_size integer not null,
   p_container char(10) not null,
   p_retailprice decimal(12,2) not null,
   p_comment varchar(23) not null,
   primary key (p_partkey)
);

create table supplier (
   s_suppkey integer not null,
   s_name char(25) not null,
   s_address varchar(40) not null,
   s_nationkey integer not null,
   s_phone char(15) not null,
   s_acctbal decimal(12,2) not null,
   s_comment varchar(101) not null,
   primary key (s_suppkey)
);

create table partsupp (
   ps_partkey integer not null,
   ps_suppkey integer not null,
   ps_availqty integer not null,
   ps_supplycost decimal(12,2) not null,
   ps_comment varchar(199) not null,
   primary key (ps_partkey,ps_suppkey)
);

create table customer (
   c_custkey integer not null,
   c_name varchar(25) not null,
   c_address varchar(40) not null,
   c_nationkey integer not null,
   c_phone char(15) not null,
   c_acctbal decimal(12,2) not null,
   c_mktsegment char(10) not null,
   c_comment varchar(117) not null,
   primary key (c_custkey)
);

create table orders (
   o_orderkey integer not null,
   o_custkey integer not null,
   o_orderstatus char(1) not null,
   o_totalprice decimal(12,2) not null,
   o_orderdate date not null,
   o_orderpriority char(15) not null,
   o_clerk char(15) not null,
   o_shippriority integer not null,
   o_comment varchar(79) not null,
   primary key (o_orderkey)
);

create table lineitem (
   l_orderkey integer not null,
   l_partkey integer not null,
   l_suppkey integer not null,
   l_linenumber integer not null,
   l_quantity decimal(12,2) not null,
   l_extendedprice decimal(12,2) not null,
   l_discount decimal(12,2) not null,
   l_tax decimal(12,2) not null,
   l_returnflag char(1) not null,
   l_linestatus char(1) not null,
   l_shipdate date not null,
   l_commitdate date not null,
   l_receiptdate date not null,
   l_shipinstruct char(25) not null,
   l_shipmode char(10) not null,
   l_comment varchar(44) not null,
   primary key (l_orderkey,l_linenumber)
);

create table nation (
   n_nationkey integer not null,
   n_name char(25) not null,
   n_regionkey integer not null,
   n_comment varchar(152) not null,
   primary key (n_nationkey)
);

create table region (
   r_regionkey integer not null,
   r_name char(25) not null,
   r_comment varchar(152) not null,
   primary key (r_regionkey)
);
`;

export const ScriptEditor: React.FC<Props> = (props: Props) => {
    const backend = useBackend();
    const backendResolver = useBackendResolver();
    if (backend.unresolved()) {
        backendResolver();
    }

    // Prepare a script for the editor
    const [script, setScript] = React.useState<flatsql.FlatSQLScript | null>(null);
    const instance = backend.value?.instance;
    React.useEffect(() => {
        if (!instance) return;
        const s = instance!.createScript();
        setScript(s);
        return () => {
            s?.delete();
        };
    }, [instance]);

    if (instance && script) {
        const config = new EditorContext(instance, script, null, (state: EditorContext) => {});
        return (
            <div className={styles.container}>
                <div className={styles.headerbar}>
                    <div className={styles.headerbar_left}>
                        <div className={styles.headerbar_script_title}>SQL Schema</div>
                    </div>
                    <div className={styles.headerbar_right}>
                        <div className={styles.example_loader_container}>
                            <div className={styles.example_loader_button}>
                                <svg width="20px" height="20px">
                                    <use xlinkHref={`${iconLoadExample}#sym`} />
                                </svg>
                            </div>
                        </div>
                    </div>
                </div>
                <div className={styles.navbar}>
                    <div className={styles.navbar_tabs}>
                        <div className={cn(styles.navbar_tab)}>
                            <svg width="22px" height="22px">
                                <use xlinkHref={`${iconMainScript}#sym`} />
                            </svg>
                        </div>
                        <div className={cn(styles.navbar_tab, styles.navbar_tab_active)}>
                            <svg width="22px" height="22px">
                                <use xlinkHref={`${iconExternalScript}#sym`} />
                            </svg>
                        </div>
                    </div>
                    <div className={styles.navbar_account}>
                        <div className={styles.navbar_account_button}>
                            <svg width="24px" height="24px">
                                <use xlinkHref={`${iconAccount}#sym`} />
                            </svg>
                        </div>
                    </div>
                </div>
                <div className={styles.editor_with_loader}>
                    <div className={styles.editor}>
                        <AutoSizer>
                            {(s: { height: number; width: number }) => (
                                <CodeMirror
                                    className={styles.codemirror}
                                    value={TMP_TPCH_SCHEMA}
                                    extensions={[FlatSQLEditor.of(config)]}
                                    width={`${s.width}px`}
                                    height={`${s.height}px`}
                                />
                            )}
                        </AutoSizer>
                    </div>
                    <div className={styles.loader_container} />
                </div>
            </div>
        );
    } else {
        return <div>Loading</div>;
    }
};
