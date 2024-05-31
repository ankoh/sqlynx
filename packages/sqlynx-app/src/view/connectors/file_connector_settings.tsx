import * as React from 'react';

import { classNames } from '../../utils/classnames.js';
import { EXAMPLE_SCHEMAS } from '../../session/example_scripts.js';

import * as symbols from '../../../static/svg/symbols.generated.svg';
import * as baseStyle from './connector_settings.module.css';
import * as style from './file_connector_settings.module.css';
import { ScriptMetadata, ScriptType } from '../../session/script_metadata.js';

const LOG_CTX = "files_connector";

interface Props {}

function SchemaEntry(props: {metadata: ScriptMetadata }) {
    return (<div key={props.metadata.scriptId} className={style.example_script}>
        <div className={classNames(style.example_script_icon, style.example_script_icon_schema)}>
            <svg width="14px" height="14px">
                <use xlinkHref={`${symbols}#database`} />
            </svg>
        </div>
        <div className={style.example_script_name}>
            {props.metadata.name}
        </div>
        <div className={style.example_script_info}>
            <div className={style.example_script_table_count}>
                <svg width="12px" height="12px">
                    <use xlinkHref={`${symbols}#rows`} />
                </svg>
                <span className={style.example_script_table_count_label}>
                    {props.metadata.annotations?.tableDefs?.size ?? 0}
                </span>
            </div>
        </div>
    </div>)
};
function QueryEntry(props: {metadata: ScriptMetadata}) {
    return (<div key={props.metadata.scriptId} className={style.example_script}>
        <div className={classNames(style.example_script_icon, style.example_script_icon_query)}>
            <svg width="14px" height="14px">
                <use xlinkHref={`${symbols}#search`} />
            </svg>
        </div>
        <div className={style.example_script_name}>
            {props.metadata.name}
        </div>
        <div className={style.example_script_info}>
            <div className={style.example_script_table_count}>
                <svg width="12px" height="12px">
                    <use xlinkHref={`${symbols}#rows`} />
                </svg>
                <span className={style.example_script_table_count_label}>       {props.metadata.annotations?.tableRefs?.size ?? 0}
                </span>
            </div>
        </div>
    </div>)
};

export const FileConnectorSettings: React.FC<Props> = (_props: Props) => {
    const example_schemas_out: React.ReactElement[] = [];
    for (const example of EXAMPLE_SCHEMAS) {
        const queriesOut: React.ReactElement[] = [];
        let i = 0;
        queriesOut.push(<SchemaEntry key={i++} metadata={example.schema} />);
        for (const query of example.queries) {
            queriesOut.push(<QueryEntry key={i++} metadata={query} />);
        }
        example_schemas_out.push(
            <div key={example.schema.scriptId} className={style.example_schema}>
                <div className={style.example_schema_name}>
                    {example.name}
                </div>
                <div className={style.example_scripts}>
                    {queriesOut}
                </div>
            </div>
        );
    }

    return (
        <div className={baseStyle.layout}>
            <div className={baseStyle.connector_header_container}>
                <div className={baseStyle.platform_logo}>
                    <svg width="24px" height="24px">
                        <use xlinkHref={`${symbols}#folder`} />
                    </svg>
                </div>
                <div className={baseStyle.platform_name} aria-labelledby="connector-files">
                    Files
                </div>
            </div >
            <div className={baseStyle.body_container}>
                <div className={baseStyle.section}>
                    <div className={classNames(baseStyle.body_section_layout)}>
                        History
                    </div>
                </div>
                <div className={baseStyle.section}>
                    <div className={classNames(style.example_section_layout, baseStyle.body_section_layout)}>
                        Examples
                        {example_schemas_out}
                    </div>
                </div>
            </div>
        </ div>
    );
};
