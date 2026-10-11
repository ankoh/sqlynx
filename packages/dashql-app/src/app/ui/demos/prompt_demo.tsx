import * as React from 'react';
import * as dashql from '@ankoh/dashql-core';
import * as styles from './prompt_demo.module.css';

import symbols from '@ankoh/dashql-svg-symbols';

import { EditorState, Extension, StateEffect } from '@codemirror/state';
import { EditorView, drawSelection, keymap, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";

import { useDashQLCoreSetup } from '../../providers/core_provider.js';
import { useLogger } from '../../../platform/logger/logger_provider.js';
import { DashQLExtensions } from '../../notebook/scripts/editor/dashql_extension.js';
import { DashQLUpdateEffect, DashQLProcessorUpdateOut } from '../../notebook/scripts/editor/dashql_processor.js';
import { CodeMirrorSearchExtensions } from '../../notebook/scripts/editor/codemirror.js';
import * as themes from '../../notebook/scripts/editor/themes/index.js';

const LOG_CTX = "prompt_demo";

/// Create CodeMirror extensions for the prompt editor
/// This is a minimal setup without line numbers and gutters
function createPromptExtensions(): Extension[] {
    const keymapExtension = keymap.of([
        ...defaultKeymap,
        ...historyKeymap
    ]);
    const extensions: Extension[] = [
        themes.xcode.xcodeLight,
        drawSelection(),
        history(),
        ...DashQLExtensions,
        ...CodeMirrorSearchExtensions,
        keymapExtension,
        placeholder("select * from orders order by timestamp desc limit 10"),
        // Auto-height: let the content determine the height
        EditorView.theme({
            "&": {
                minHeight: "24px",
            },
            ".cm-scroller": {
                overflow: "visible",
            },
            ".cm-content": {
                minHeight: "24px",
                padding: "0",
            },
            ".cm-line": {
                padding: "0",
            },
        }),
    ];
    return extensions;
}

interface PromptEditorProps {
    className?: string;
    onSubmit?: (text: string) => void;
}

/// A minimal prompt editor backed by CodeMirror and wired with dashql-core
const PromptEditor: React.FC<PromptEditorProps> = (props) => {
    const logger = useLogger();
    const setupCore = useDashQLCoreSetup();

    // Core instance and editor session
    const [catalog, setCatalog] = React.useState<dashql.DashQLCatalog | null>(null);
    const [scriptSession, setScriptSession] = React.useState<dashql.DashQLScriptSession | null>(null);
    const runtimeRef = React.useRef<{
        catalog: dashql.DashQLCatalog;
        scriptSession: dashql.DashQLScriptSession;
    } | null>(null);

    // Editor DOM node and view
    const [editorNode, setEditorNode] = React.useState<HTMLDivElement | null>(null);
    const [editorView, setEditorView] = React.useState<EditorView | null>(null);

    // Initialize dashql-core
    React.useEffect(() => {
        let disposed = false;
        const init = async () => {
            try {
                const instance = await setupCore(LOG_CTX);
                const cat = instance.createCatalog();
                const session = instance.createScriptSession(cat);
                if (disposed) {
                    session.destroy();
                    cat.destroy();
                    return;
                }
                runtimeRef.current = { catalog: cat, scriptSession: session };
                setCatalog(cat);
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
            runtimeRef.current?.scriptSession.destroy();
            runtimeRef.current?.catalog.destroy();
            runtimeRef.current = null;
        };
    }, []);

    // Create CodeMirror view when DOM node is mounted
    React.useEffect(() => {
        if (editorNode == null) {
            return;
        }
        logger.info("creating prompt editor view", {}, LOG_CTX);

        const extensions = createPromptExtensions();
        const view = new EditorView({
            state: EditorState.create({ extensions }),
            parent: editorNode,
        });
        setEditorView(view);

        return () => {
            view.destroy();
            setEditorView(null);
        };
    }, [editorNode]);

    // Wire CodeMirror with dashql-core when both are ready
    React.useEffect(() => {
        if (editorView == null || scriptSession == null) {
            return;
        }

        let currentUpdate = scriptSession.analyze();
        let currentCompletion: DashQLProcessorUpdateOut['scriptCompletion'] = null;
        // Helper to handle processor updates
        const onUpdate = (update: DashQLProcessorUpdateOut) => {
            if (currentCompletion?.buffer !== update.scriptCompletion?.buffer) currentCompletion?.buffer.destroy();
            currentUpdate = update.editorUpdate ?? currentUpdate;
            currentCompletion = update.scriptCompletion;
            // Here you could track the processed state
            logger.debug("processor update", {
                scriptKey: String(update.scriptKey),
                analysisAvailable: String(currentUpdate.analysisAvailable),
            }, LOG_CTX);
        };

        // Initial setup: push the session into the processor
        const effects: StateEffect<any>[] = [
            DashQLUpdateEffect.of({
                scriptKey: scriptSession.getCatalogEntryId(),
                scriptSession,
                editorUpdate: currentUpdate,
                scriptBuffers: null,
                scriptCompletion: null,
                scriptPendingDiff: null,
                derivedFocus: null,
                onUpdate,
            }),
        ];
        editorView.dispatch({ effects });

        return () => {
            currentCompletion?.buffer.destroy();
        };

    }, [editorView, scriptSession]);

    // Handle Cmd/Ctrl+Enter to submit
    React.useEffect(() => {
        if (editorView == null || props.onSubmit == null) {
            return;
        }

        const submitKeymap = keymap.of([{
            key: "Mod-Enter",
            run: () => {
                const text = editorView.state.doc.toString();
                if (text.trim()) {
                    props.onSubmit?.(text);
                }
                return true;
            },
        }]);

        // Add the keymap extension
        editorView.dispatch({
            effects: StateEffect.appendConfig.of(submitKeymap),
        });
    }, [editorView, props.onSubmit]);

    return (
        <div className={`${styles.prompt_editor} ${props.className ?? ''}`}>
            <div className={styles.prompt_editor_content} ref={setEditorNode} />
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
                <PromptEditor onSubmit={handleSubmit} />
                <div className={styles.prompt_hint}>
                    Press <kbd>⌘</kbd> + <kbd>Enter</kbd> to submit
                </div>
            </div>
        </div>
    );
}
