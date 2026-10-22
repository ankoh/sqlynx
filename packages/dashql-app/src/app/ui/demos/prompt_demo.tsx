import * as React from 'react';
import * as dashql from '@ankoh/dashql-core';
import * as styles from './prompt_demo.module.css';

import symbols from '@ankoh/dashql-svg-symbols';

import { useDashQLCoreSetup } from '../../providers/core_provider.js';
import { useLogger } from '../../../platform/logger/logger_provider.js';
import { PromptEditor } from '../../session/scripts/editor/prompt_editor.js';

const LOG_CTX = "prompt_demo";

/// A prompt backed by its own catalog and script session
const DemoPrompt: React.FC<{ onSubmit: (text: string) => void }> = (props) => {
    const logger = useLogger();
    const setupCore = useDashQLCoreSetup();
    const [scriptSession, setScriptSession] = React.useState<dashql.DashQLScriptSession | null>(null);

    // Initialize dashql-core
    React.useEffect(() => {
        let disposed = false;
        let runtime: { catalog: dashql.DashQLCatalog; scriptSession: dashql.DashQLScriptSession } | null = null;
        const init = async () => {
            try {
                const instance = await setupCore(LOG_CTX);
                const catalog = instance.createCatalog();
                const session = instance.createScriptSession(catalog);
                if (disposed) {
                    session.destroy();
                    catalog.destroy();
                    return;
                }
                runtime = { catalog, scriptSession: session };
                setScriptSession(session);
                logger.info("prompt editor initialized", {}, LOG_CTX);
            } catch (e) {
                logger.error("failed to initialize prompt editor", { error: String(e) }, LOG_CTX);
            }
        };
        init();
        // Cleanup on unmount
        return () => {
            disposed = true;
            runtime?.scriptSession.destroy();
            runtime?.catalog.destroy();
        };
    }, []);

    return (
        <div className={styles.prompt_editor}>
            <PromptEditor
                className={styles.prompt_editor_content}
                scriptSession={scriptSession}
                placeholder="select * from orders order by timestamp desc limit 10"
                onSubmit={props.onSubmit}
            />
        </div>
    );
};

export function PromptDemoPage(): React.ReactElement {
    const logger = useLogger();

    const handleSubmit = React.useCallback((text: string) => {
        logger.info("prompt submitted", { text }, LOG_CTX);
        console.log("Submitted:", text);
    }, [logger]);

    return (
        <div className={styles.root}>
            <div className={styles.prompt_logo}>
                <svg width="100%" height="100%">
                    <use xlinkHref={`${symbols}#dashql`} />
                </svg>
            </div>
            <div className={styles.prompt_container}>
                <DemoPrompt onSubmit={handleSubmit} />
                <div className={styles.prompt_hint}>
                    Press <kbd>Enter</kbd> to submit
                </div>
            </div>
        </div>
    );
}
