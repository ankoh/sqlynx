import * as React from 'react';

import { classNames } from '../../utils/classnames.js';
import { EXAMPLE_SCHEMAS } from '../../session/example_scripts.js';

import * as symbols from '../../../static/svg/symbols.generated.svg';
import * as baseStyle from './connector_settings.module.css';
import * as style from './file_connector_settings.module.css';
import { getScriptTypeName, ScriptMetadata } from '../../session/script_metadata.js';

const LOG_CTX = "files_connector";

interface Props {}

export const FileConnectorSettings: React.FC<Props> = (_props: Props) => {
    const example_schemas_out: React.ReactElement[] = [];
    for (const example of EXAMPLE_SCHEMAS) {
        const queriesOut: React.ReactElement[] = [];
        const renderQuery = (metadata: ScriptMetadata) => (
            <div key={metadata.scriptId} className={style.example_script}>
                <div className={style.example_script_name}>
                    {metadata.name}
                </div>
                <div className={style.example_script_info}>
                    <div className={style.example_script_type}>
                        {getScriptTypeName(metadata.scriptType)}
                    </div>
                    <div className={style.example_script_table_count}>
                        <svg width="12px" height="12px">
                            <use xlinkHref={`${symbols}#table`} />
                        </svg>
                        <span className={style.example_script_table_count_label}>
                            {metadata.annotations?.tableRefs?.size ?? 0}
                        </span>
                    </div>
                </div>
            </div>
        );
        queriesOut.push(renderQuery(example.schema));
        for (const query of example.queries) {
            queriesOut.push(renderQuery(query));
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
