import * as React from 'react';

import { classNames } from '../../utils/classnames.js';
import { EXAMPLE_SCHEMAS } from '../../session/example_scripts.js';

import * as symbols from '../../../static/svg/symbols.generated.svg';
import * as baseStyle from './connector_settings.module.css';
import * as style from './file_connector_settings.module.css';
import { createScriptMetadata, ScriptMetadata, ScriptOriginType, ScriptType } from '../../session/script_metadata.js';
import { ConnectorType } from '../../connectors/connector_info.js';

const LOG_CTX = "files_connector";

interface Props {}

function SchemaEntry(props: {metadata: ScriptMetadata }) {
    return (<div key={props.metadata.scriptId} className={style.file}>
        <div className={classNames(style.file_icon, style.file_icon_schema)}>
            <svg width="14px" height="14px">
                <use xlinkHref={`${symbols}#database`} />
            </svg>
        </div>
        <div className={style.file_name}>
            {props.metadata.name}
        </div>
        <div className={style.file_info}>
            <div className={style.file_table_count}>
                <svg width="12px" height="12px">
                    <use xlinkHref={`${symbols}#rows`} />
                </svg>
                <span className={style.file_table_count_label}>
                    {props.metadata.annotations?.tableDefs?.size ?? 0}
                </span>
            </div>
        </div>
    </div>)
};
function QueryEntry(props: {metadata: ScriptMetadata}) {
    return (<div key={props.metadata.scriptId} className={style.file}>
        <div className={classNames(style.file_icon, style.file_icon_query)}>
            <svg width="14px" height="14px">
                <use xlinkHref={`${symbols}#search`} />
            </svg>
        </div>
        <div className={style.file_name}>
            {props.metadata.name}
        </div>
        <div className={style.file_info}>
            <div className={style.file_table_count}>
                <svg width="12px" height="12px">
                    <use xlinkHref={`${symbols}#rows`} />
                </svg>
                <span className={style.file_table_count_label}>       {props.metadata.annotations?.tableRefs?.size ?? 0}
                </span>
            </div>
        </div>
    </div>)
};

export const FileConnectorSettings: React.FC<Props> = (_props: Props) => {
    const example_groups: React.ReactElement[] = [];
    for (const example of EXAMPLE_SCHEMAS) {
        const queriesOut: React.ReactElement[] = [];
        let i = 0;
        queriesOut.push(<SchemaEntry key={i++} metadata={example.schema} />);
        for (const query of example.queries) {
            queriesOut.push(<QueryEntry key={i++} metadata={query} />);
        }
        example_groups.push(
            <div key={example.schema.scriptId} className={style.file_group}>
                <div className={style.file_group_name}>
                    {example.name}
                </div>
                <div className={style.files}>
                    {queriesOut}
                </div>
            </div>
        );
    }

    const sfSchema0 = createScriptMetadata({
        schemaId: null,
        name: "sf_1717225402_0.sql",
        scriptType: ScriptType.SCHEMA,
        originType: ScriptOriginType.LOCAL,
        httpURL: null,
        annotations: {
            tableDefs: new Set(["some_dmo__dlm", "another_dmo__dlm"]),
            tenantName: "a360/falcondev/0b306c1896f34230a54b13db23f019a6"
        }
    });

    const sfQuery0 = createScriptMetadata({
        schemaId: sfSchema0.schemaId,
        name: "sf_1717225482_0.sql",
        scriptType: ScriptType.QUERY,
        originType: ScriptOriginType.LOCAL,
        httpURL: null,
        annotations: {
            tableRefs: new Set(["some_dmo__dlm"]),
            tenantName: "a360/falcondev/0b306c1896f34230a54b13db23f019a6"
        }
    })

    const history = {
        [ConnectorType.SALESFORCE_DATA_CLOUD]: [
            sfQuery0, sfSchema0
        ],
        [ConnectorType.HYPER_GRPC]: []
    };

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
                    <div className={classNames(style.scripts_layout, baseStyle.body_section_layout)}>
                        <div className={style.scripts_section_header}>
                            History
                        </div>
                    </div>
                </div>
                <div className={baseStyle.section}>
                    <div className={classNames(style.scripts_layout, baseStyle.body_section_layout)}>
                        <div className={style.scripts_section_header}>
                            Examples
                        </div>
                        {example_groups}
                    </div>
                </div>
            </div>
        </ div>
    );
};
