import * as React from 'react';
import * as styles from './script_info.module.css';

import { CopyToClipboardButton } from '../../utils/clipboard.js';
import { ButtonSize, ButtonVariant } from '../foundations/button.js';

const LOG_CTX = "query_result_viewer"

interface ScriptInfoEntryProps {
    name: string;
    value: string;
    clipboard?: boolean;
}

function ScriptInfoEntry(props: ScriptInfoEntryProps) {
    return (
        <>
            <div className={styles.metric_key}>
                {props.name}
            </div>
            {
                props.clipboard
                    ? <div className={styles.metric_clipboard}>
                        <CopyToClipboardButton
                            variant={ButtonVariant.Default}
                            size={ButtonSize.Small}
                            value={props.value}
                            logContext={LOG_CTX}
                            aria-label={`Copy ${props.name}`}
                            aria-labelledby="" />
                    </div>
                    : <div className={styles.metric_value}>
                        {props.value}
                    </div>
            }
        </>
    );
}

interface ScriptInfoProps {
    entries: [string, string][];
}

export function ScriptInfo(props: ScriptInfoProps) {
    return (
        <div className={styles.info_container}>
            <div className={styles.metrics_container}>
                <div className={styles.metrics_group}>
                    {props.entries.map(([k, v], i) => (
                        <ScriptInfoEntry key={i} name={k} value={v} />
                    ))}
                </div>
            </div>
        </div>
    );
}

