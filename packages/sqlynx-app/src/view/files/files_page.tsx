import * as React from 'react';
import { TextInput } from '@primer/react';

import { classNames } from '../../utils/classnames.js';
import { EXAMPLE_SCHEMAS } from '../../session/example_scripts.js';

import * as symbols from '../../../static/svg/symbols.generated.svg';
import * as style from './files_page.module.css';
import { createScriptMetadata, ScriptMetadata, ScriptOriginType, ScriptType } from '../../session/script_metadata.js';
import { ConnectorType } from '../../connectors/connector_info.js';

const LOG_CTX = "files_connector";

interface Props { }

function SchemaEntry(props: { metadata: ScriptMetadata }) {
    return (<div key={props.metadata.scriptId} className={style.file}>
        <div className={classNames(style.file_icon, style.file_icon_schema)}>
            <svg width="14px" height="14px">
                <use xlinkHref={`${symbols}#database`} />
            </svg>
        </div>
        <div className={style.file_name}>
            {props.metadata.name}
        </div>
    </div>)
}

function QueryEntry(props: { metadata: ScriptMetadata }) {
    return (<div key={props.metadata.scriptId} className={style.file}>
        <div className={classNames(style.file_icon, style.file_icon_query)}>
            <svg width="14px" height="14px">
                <use xlinkHref={`${symbols}#search`} />
            </svg>
        </div>
        <div className={style.file_name}>
            {props.metadata.name}
        </div>
    </div>)
}

interface Token {
    id: number;
    text: string;
}
const ITEMS: Token[] = [
    {text: 'vector_search', id: 0},
    {text: 'a360/falcondev/b306c1896f34230a54b13db23f019a6', id: 1},
];
const MOCK_TOKENS = ITEMS.slice(0, 3);

export const FilesPage: React.FC<Props> = (_props: Props) => {
    const sfSchema0 = createScriptMetadata({
        schemaId: null,
        name: "sf_1717225402_0.sql",
        scriptType: ScriptType.SCHEMA,
        originType: ScriptOriginType.LOCAL,
        httpURL: null,
        annotations: {
            tableDefs: new Set(["some_dmo__dlm", "another_dmo__dlm"]),
            tenantName: "a360/falcondev/b306c1896f34230a54b13db23f019a6"
        },
        immutable: true,
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
        },
        immutable: true,
    })

    const history: Map<ConnectorType, ScriptMetadata[]> = new Map([
        [ConnectorType.SALESFORCE_DATA_CLOUD, [
            sfQuery0, sfSchema0
        ]],
        [ConnectorType.HYPER_GRPC, []]
    ]);

    const historyEntries: React.ReactElement[] = [];
    for (const [connector, scripts] of history) {
        let i = 0;
        for (const script of scripts) {
            if (script.scriptType == ScriptType.SCHEMA) {
                historyEntries.push(<SchemaEntry key={i++} metadata={script} />);
            } else {
                historyEntries.push(<QueryEntry key={i++} metadata={script} />);
            }
        }
    }

    const exampleGroups: React.ReactElement[] = [];
    for (const example of EXAMPLE_SCHEMAS) {
        const queriesOut: React.ReactElement[] = [];
        let i = 0;
        queriesOut.push(<SchemaEntry key={i++} metadata={example.schema} />);
        for (const query of example.queries) {
            queriesOut.push(<QueryEntry key={i++} metadata={query} />);
        }
        exampleGroups.push(
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

    return (
        <div className={style.page}>
            <div className={style.header_container}>
                <div className={style.header_left_container}>
                    <div className={style.page_title}>Files</div>
                </div>
            </div>

            <div className={style.layout}>
                <div className={style.body_container}>
                    <div className={style.section}>
                        <div className={style.search_layout}>
                            <TextInput
                                className={style.search_input}
                                placeholder="Filter Files"
                                size="medium"
                            />
                            <div className={style.search_tokens}>
                                <div className={style.search_token}>
                                    vector_search
                                </div>
                                <div className={style.search_token}>
                                    a360/falcondev/0b306c1896f34230a54b13db23f019a6
                                </div>
                            </div>
                        </div>
                    </div>
                    <div className={style.section}>
                        <div className={style.scripts_layout}>
                            <div className={style.file_group}>
                            <div className={style.file_group_name}>
                                    History
                                </div>
                                <div className={style.files}>
                                    {historyEntries}
                                </div>
                            </div>
                        </div>
                    </div>
                    <div className={style.section}>
                        <div className={style.scripts_layout}>
                        {exampleGroups}
                        </div>
                    </div>
                </div>
            </ div>

        </div>
    );
};
