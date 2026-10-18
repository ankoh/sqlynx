import * as React from 'react';
import * as styles from './ai_settings_view.module.css';

import { XIcon } from '../foundations/symbol_icon.js';

import { Button, ButtonSize, ButtonVariant, IconButton } from '../foundations/button.js';
import { TextField } from '../foundations/text_field.js';
import { KeyValueListBuilder, KeyValueListElement } from '../foundations/keyvalue_list.js';
import { IndicatorStatus, StatusIndicator } from '../foundations/status_indicator.js';
import { SegmentedControl, SegmentedControlSize } from '../foundations/segmented_control.js';
import { AIClient } from '../../platform/ai/ai_client.js';
import {
    AI_TASKS,
    AIModelChoice,
    AIModelHeader,
    AITask,
    bundledModelRunsTask,
    DEFAULT_EXTERNAL_AI_MODEL,
    ExternalAIModelSettings,
    resolveAIModelChoice,
    resolveExternalAIModel,
} from '../../platform/ai/ai_models.js';
import { useAIModels, useAIModelsReconfigure } from '../../app/config/ai_models_provider.js';
import { ATLAS_EMBEDDER_CONFIG } from '../../atlas/index/model.js';
import { useHttpClient } from '../../platform/http/http_client_provider.js';
import { useLogger } from '../../platform/logger/logger_provider.js';

const LOG_CTX = 'ai_settings';

const TASK_INFO: Record<AITask, { title: string; description: string }> = {
    [AITask.Describe]: {
        title: 'Describe',
        description: 'Smart model to describe SQL',
    },
    [AITask.Embed]: {
        title: 'Embed',
        description: 'Fast model to compute embeddings ad-hoc',
    },
};

const MODEL_CHOICES: { choice: AIModelChoice; label: string }[] = [
    { choice: AIModelChoice.Bundled, label: 'Bundled' },
    { choice: AIModelChoice.External, label: 'External' },
];

interface TestState {
    status: IndicatorStatus;
    text: string;
    error?: string;
}

const INITIAL_TEST_STATE: TestState = {
    status: IndicatorStatus.None,
    text: 'Not tested',
};

const HeaderKeyIcon = () => <div>Header</div>;
const HeaderValueIcon = () => <div>Value</div>;
const UrlIcon = () => <div>URL</div>;
const ModelIcon = () => <div>Model</div>;

function headersToKeyValueList(headers: AIModelHeader[]): KeyValueListElement[] {
    return headers.map(h => ({ key: h.name, value: h.value }));
}

function keyValueListToHeaders(elements: KeyValueListElement[]): AIModelHeader[] {
    return elements.map(e => ({ name: e.key, value: e.value }));
}

function SectionHeader(props: { title: string; description?: string; children?: React.ReactNode }) {
    return (
        <div className={styles.section_header}>
            <div className={styles.section_title_container}>
                <div className={styles.section_title}>{props.title}</div>
                {props.description && <div className={styles.section_description}>{props.description}</div>}
            </div>
            {props.children}
        </div>
    );
}

/// The embedding model that ships with the app and runs in the browser
function BundledModelSection() {
    return (
        <div className={styles.section}>
            <SectionHeader title="Bundled Model">
                <a
                    className={styles.bundled_model_name}
                    href={`https://huggingface.co/${ATLAS_EMBEDDER_CONFIG.model}`}
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    {ATLAS_EMBEDDER_CONFIG.model.split('/').pop()}
                </a>
            </SectionHeader>
        </div>
    );
}

/// The one model behind an OpenAI-compatible endpoint
function ExternalModelSection() {
    const settings = useAIModels();
    const reconfigure = useAIModelsReconfigure();
    const httpClient = useHttpClient();
    const logger = useLogger();

    const stored = settings?.config?.external;
    const endpointUrl = stored?.endpointUrl ?? DEFAULT_EXTERNAL_AI_MODEL.endpointUrl;
    const model = stored?.model ?? DEFAULT_EXTERNAL_AI_MODEL.model;
    const headers = stored?.headers ?? DEFAULT_EXTERNAL_AI_MODEL.headers;

    const [testState, setTestState] = React.useState<TestState>(INITIAL_TEST_STATE);
    const abortRef = React.useRef<AbortController | null>(null);
    React.useEffect(() => () => abortRef.current?.abort(), []);

    const update = (patch: ExternalAIModelSettings) => {
        reconfigure(s => ({ ...s, config: { ...s.config, external: { endpointUrl, model, headers, ...patch } } }));
    };
    const modifyHeaders = (updater: (prev: KeyValueListElement[]) => KeyValueListElement[]) => {
        update({ headers: keyValueListToHeaders(updater(headersToKeyValueList(headers))) });
    };

    const runTest = async () => {
        if (httpClient == null) return;
        abortRef.current?.abort();
        const ac = new AbortController();
        abortRef.current = ac;
        setTestState({ status: IndicatorStatus.Running, text: 'Testing…' });
        try {
            const client = new AIClient(logger, httpClient, resolveExternalAIModel(settings));
            const models = await client.listModels(ac.signal);
            if (ac.signal.aborted) return;
            const reachable = `Reachable, ${models.length} model${models.length === 1 ? '' : 's'} available`;
            if (models.length > 0 && !models.includes(client.config.model)) {
                setTestState({ status: IndicatorStatus.Failed, text: reachable, error: `${client.config.model} is not one of them` });
            } else {
                setTestState({ status: IndicatorStatus.Succeeded, text: reachable });
            }
        } catch (e: any) {
            if (ac.signal.aborted) return;
            const msg = e instanceof Error ? e.message : String(e);
            logger.warn('AI model test failed', { error: msg }, LOG_CTX);
            setTestState({ status: IndicatorStatus.Failed, text: 'Failed', error: msg });
        }
    };

    const editable = settings != null;
    return (
        <div className={styles.section}>
            <SectionHeader
                title="External Model"
                description="A model behind an OpenAI-compatible server, e.g. Ollama, OpenAI or vLLM"
            />
            <div className={styles.status_section}>
                <div className={styles.status_bar}>
                    <div className={styles.status_indicator}>
                        <StatusIndicator
                            className={styles.status_indicator_spinner}
                            status={testState.status}
                        />
                    </div>
                    <div className={styles.status_text}>{testState.text}</div>
                    {testState.error && (
                        <div className={styles.status_error}>{testState.error}</div>
                    )}
                </div>
                <Button
                    variant={ButtonVariant.Primary}
                    size={ButtonSize.Small}
                    onClick={runTest}
                    disabled={!editable || httpClient == null || testState.status === IndicatorStatus.Running}
                >
                    Test
                </Button>
            </div>
            <div className={styles.section_layout}>
                <TextField
                    className={styles.grid_column_1}
                    name="Endpoint URL"
                    caption="Base URL of the OpenAI-compatible server"
                    value={endpointUrl}
                    placeholder={DEFAULT_EXTERNAL_AI_MODEL.endpointUrl}
                    leadingVisual={UrlIcon}
                    onChange={e => update({ endpointUrl: e.target.value })}
                    disabled={!editable}
                    logContext={LOG_CTX}
                />
                <TextField
                    name="Model"
                    caption="Model identifier"
                    value={model}
                    placeholder={DEFAULT_EXTERNAL_AI_MODEL.model}
                    leadingVisual={ModelIcon}
                    onChange={e => update({ model: e.target.value })}
                    disabled={!editable}
                    logContext={LOG_CTX}
                />
                <KeyValueListBuilder
                    className={styles.grid_column_1_span_2}
                    title="Additional Headers"
                    caption="Extra HTTP headers added to each request (e.g. Authorization)"
                    keyIcon={HeaderKeyIcon}
                    valueIcon={HeaderValueIcon}
                    addButtonLabel="Add Header"
                    elements={headersToKeyValueList(headers)}
                    modifyElements={modifyHeaders}
                    disabled={!editable}
                />
            </div>
        </div>
    );
}

/// Which model every task runs on
function TaskSection() {
    const settings = useAIModels();
    const reconfigure = useAIModelsReconfigure();
    return (
        <div className={styles.section}>
            <SectionHeader title="Tasks" description="The model that every task runs on" />
            <div className={styles.task_list}>
                {AI_TASKS.map(task => {
                    const info = TASK_INFO[task];
                    const selected = resolveAIModelChoice(task, settings);
                    return (
                        <React.Fragment key={task}>
                            <div id={`ai-task-${task}`} className={styles.task_name_container}>
                                <div className={styles.task_name}>{info.title}</div>
                                <div className={styles.section_description}>{info.description}</div>
                            </div>
                            <div className={styles.task_choice}>
                                <SegmentedControl
                                    aria-labelledby={`ai-task-${task}`}
                                    size={SegmentedControlSize.Small}
                                    onChange={index => {
                                        if (settings == null) return;
                                        reconfigure(s => ({ ...s, tasks: { ...s.tasks, [task]: MODEL_CHOICES[index].choice } }));
                                    }}
                                >
                                    {MODEL_CHOICES.map(c => {
                                        const unsupported = c.choice === AIModelChoice.Bundled && !bundledModelRunsTask(task);
                                        return (
                                            <SegmentedControl.Button
                                                key={c.choice}
                                                selected={selected === c.choice}
                                                disabled={settings == null || unsupported}
                                                title={unsupported ? 'The bundled model only computes embeddings' : undefined}
                                            >
                                                {c.label}
                                            </SegmentedControl.Button>
                                        );
                                    })}
                                </SegmentedControl>
                            </div>
                        </React.Fragment>
                    );
                })}
            </div>
        </div>
    );
}

export function AISettingsView(props: { onClose: () => void; }) {
    return (
        <div className={styles.settings_root}>
            <div className={styles.header_container}>
                <div className={styles.header_left_container}>
                    <div className={styles.title}>AI Models</div>
                </div>
                <div className={styles.header_right_container}>
                    <IconButton
                        variant={ButtonVariant.Invisible}
                        aria-label="close-overlay"
                        onClick={props.onClose}
                    >
                        <XIcon />
                    </IconButton>
                </div>
            </div>
            <div className={styles.body}>
                <BundledModelSection />
                <ExternalModelSection />
                <TaskSection />
            </div>
        </div>
    );
}
