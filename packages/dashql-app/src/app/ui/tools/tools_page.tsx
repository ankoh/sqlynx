import * as React from 'react';
import icons from '@ankoh/dashql-svg-symbols';
import { Link, useLocation } from 'react-router-dom';

import * as styles from './tools_page.module.css';
import * as shared from '../../session/connections/ui/connection_settings.module.css';

import { classNames } from '../../../utils/classnames.js';
import { useRouteContext } from '../../router/router.js';

type ToolId = 'format' | 'hyperplan' | 'sparkplan';

interface ToolDefinition {
    id: ToolId;
    route: string;
    title: string;
    summary: string;
    icon: string;
    placeholder: string;
}

const TOOL_DEFINITIONS: ToolDefinition[] = [
    {
        id: 'format',
        route: '/tool/format',
        title: 'SQL Formatter',
        summary: 'Format SQL text and tune formatting behavior.',
        icon: 'settings',
        placeholder: 'Add formatter input, configuration, and output preview here.',
    },
    {
        id: 'hyperplan',
        route: '/tool/hyperplan',
        title: 'Hyper Plan Viewer',
        summary: 'Inspect and render Hyper execution plans.',
        icon: 'plan',
        placeholder: 'Add Hyper plan input and rendered plan output here.',
    },
    {
        id: 'sparkplan',
        route: '/tool/sparkplan',
        title: 'Spark Plan Viewer',
        summary: 'Inspect and render Spark execution plans.',
        icon: 'stats_24',
        placeholder: 'Add Spark plan input and rendered plan output here.',
    },
];

function ToolNavigationEntry(props: {
    tool: ToolDefinition;
    selected: boolean;
}): React.ReactElement {
    const route = useRouteContext();

    return (
        <div className={styles.tool_entry}>
            <Link
                className={classNames(styles.tool_entry_button, {
                    [styles.selected]: props.selected,
                })}
                to={props.tool.route}
                state={route}
            >
                <svg className={styles.tool_entry_icon} width="18px" height="16px" aria-hidden="true">
                    <use xlinkHref={`${icons}#${props.tool.icon}`} />
                </svg>
                <div className={styles.tool_entry_label}>{props.tool.title}</div>
            </Link>
        </div>
    );
}

function ToolCard(props: { tool: ToolDefinition }): React.ReactElement {
    return (
        <div className={shared.layout}>
            <div className={styles.tool_header}>
                <div className={styles.tool_header_icon_container}>
                    <svg className={styles.tool_header_icon} width="24px" height="24px" aria-hidden="true">
                        <use xlinkHref={`${icons}#${props.tool.icon}`} />
                    </svg>
                </div>
                <div className={styles.tool_header_copy}>
                    <div className={styles.tool_header_title}>{props.tool.title}</div>
                    <div className={styles.tool_header_summary}>{props.tool.summary}</div>
                </div>
            </div>
            <div className={shared.body_container}>
                <div className={shared.section}>
                    <div className={classNames(shared.section_layout, shared.body_section_layout)}>
                        <div className={shared.section_header}>
                            <div className={styles.section_title}>Overview</div>
                        </div>
                        <div className={shared.grid_column_1}>
                            <div className={styles.field_label}>Route</div>
                            <div className={styles.field_value}>
                                <code>{props.tool.route}</code>
                            </div>
                        </div>
                        <div>
                            <div className={styles.field_label}>Status</div>
                            <div className={styles.field_value}>Stub</div>
                        </div>
                        <div className={shared.grid_column_1_span_2}>
                            <div className={styles.placeholder_box}>{props.tool.placeholder}</div>
                        </div>
                    </div>
                </div>
                <div className={shared.section}>
                    <div className={classNames(shared.section_layout, shared.body_section_layout)}>
                        <div className={shared.section_header}>
                            <div className={styles.section_title}>Next Step</div>
                        </div>
                        <div className={shared.grid_column_1_span_2}>
                            <div className={styles.field_value}>
                                Replace this stub with the actual tool UI when the implementation is ready.
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

export const ToolsPage: React.FC = () => {
    const location = useLocation();
    const selectedTool = React.useMemo(
        () => TOOL_DEFINITIONS.find(tool => tool.route === location.pathname) ?? TOOL_DEFINITIONS[0],
        [location.pathname],
    );

    return (
        <div className={styles.container}>
            <div className={styles.header_container}>
                <div className={styles.header_left_container}>
                    <div className={styles.header_title}>Tools</div>
                </div>
            </div>
            <div className={styles.body_container}>
                <div className={styles.tool_list}>
                    <div className={styles.tool_section}>
                        {TOOL_DEFINITIONS.map(tool => (
                            <ToolNavigationEntry
                                key={tool.id}
                                tool={tool}
                                selected={tool.id === selectedTool.id}
                            />
                        ))}
                    </div>
                </div>
                <div className={styles.tool_settings_scroller}>
                    <div className={styles.tool_settings_container}>
                        <div className={styles.tool_settings_card}>
                            <ToolCard tool={selectedTool} />
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
