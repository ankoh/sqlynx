import * as React from 'react';

import { classNames } from '../../utils/classnames.js';
import { EXAMPLE_SCHEMAS } from '../../session/example_scripts.js';

import * as symbols from '../../../static/svg/symbols.generated.svg';
import * as baseStyle from './connector_settings.module.css';
import * as style from './file_connector_settings.module.css';
import { ScriptMetadata } from '../../session/script_metadata.js';

const LOG_CTX = "files_connector";

interface Props {}

export const FileConnectorSettings: React.FC<Props> = (_props: Props) => {
    const example_schemas_out: React.ReactElement[] = [];
    for (const example of EXAMPLE_SCHEMAS) {
        const queriesOut: React.ReactElement[] = [];
        const renderQuery = (metadata: ScriptMetadata) => (
            <div key={metadata.scriptId} className={style.example_query}>
                <div className={style.example_query_filename}>
                    {metadata.name}
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
                <div className={style.example_queries}>
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
