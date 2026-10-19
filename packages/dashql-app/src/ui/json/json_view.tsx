import * as React from 'react';
import * as styles from './json_view.module.css';

import { JsonViewerState, JsonViewerStateProvider } from './json_view_state.js';
import { JsonValue } from './json_value.js';

export * from './json_view_state.js';
export * from './json_nested_state.js';
export * from './json_tool_state.js';
export * from './json_arrow_symbol.js';

export type ShouldExpandNodeInitially = (
    isExpanded: boolean,
    props: { keyName?: string | number; value?: object; parentValue?: object; keyPath: (number | string)[]; level: number },
) => boolean;

export interface JsonViewProps
    extends React.DetailedHTMLProps<React.HTMLAttributes<HTMLDivElement>, HTMLDivElement> {
    /// This property contains your input JSON
    value: object;
    /// Define the root node name. @default undefined
    keyName?: string | number;
    /// Whether sort keys through `String.prototype.localeCompare()` @default false
    objectSortKeys?: boolean | ((keyA: string, keyB: string, valueA: object, valueB: object) => number);
    /// Set the indent-width for nested objects @default 15
    indentWidth?: number;
    /// Render arrays incrementally in pages of this size. Set to `0` to render all items. @default 0
    arrayPageSize?: number;
    /// When set to `true`, `objects` and `arrays` are labeled with size @default true
    displayObjectSize?: boolean;
    /// The user can copy objects and arrays to clipboard by clicking on the clipboard icon. @default true
    enableClipboard?: boolean;
    ///
    /// When set to true, all nodes will be collapsed by default. Use an integer value to collapse at a specific depth. @default false
    /// collapsed takes precedence over shouldExpandNodeInitially.
    /// @see {@link shouldExpandNodeInitially} for more details on how the initial expansion works.
    ///
    collapsed?: boolean | number;
    ///
    /// Determines whether the node should be expanded on the first render, or you can use collapsed to control the level of expansion (by default, the root is expanded).
    /// If both collapsed and shouldExpandNodeInitially are set, the value of collapsed takes precedence.
    /// @see {@link collapsed} for more details on how this works.
    ///
    shouldExpandNodeInitially?: ShouldExpandNodeInitially;
    /// Whether to highlight updates. @default true
    highlightUpdates?: boolean;
    /// Shorten long JSON strings, Set to `0` to disable this feature @default 30
    shortenTextAfterLength?: number;
    /// When the text exceeds the length, `...` will be displayed. Currently, this `...` can be customized. @default "..."
    stringEllipsis?: number;
    /// Callback function for when a treeNode is expanded or collapsed
    onExpand?: (props: { expand: boolean; value?: object; keyName?: string | number }) => void;
    /// Fires event when you copy
    onCopied?: (text: string, value?: object) => void;
    /// Transform the text before copying to clipboard
    beforeCopy?: (
        copyText: string,
        keyName?: string | number,
        value?: object,
        parentValue?: object,
        expandKey?: string,
        keyPath?: (number | string)[],
    ) => string;
}

type JsonViewComponent = React.FC<React.PropsWithRef<JsonViewProps>>;

export const AlwaysExpand: ShouldExpandNodeInitially = () => true;
export const AlwaysCollapse = () => false;

export const JsonView: JsonViewComponent = React.forwardRef<HTMLDivElement, JsonViewProps>((props, ref) => {
    const {
        value,
        keyName: _keyName,
        objectSortKeys,
        indentWidth,
        arrayPageSize,
        displayObjectSize,
        enableClipboard,
        collapsed,
        shouldExpandNodeInitially,
        highlightUpdates: _highlightUpdates,
        shortenTextAfterLength,
        stringEllipsis,
        onExpand,
        onCopied,
        beforeCopy,
        children,
        className,
        ...containerProps
    } = props;
    // Collapse nested values below a numeric depth, unless the caller decides explicitly
    const expandNodeInitially = React.useMemo<ShouldExpandNodeInitially>(() => {
        if (collapsed === true) {
            return AlwaysCollapse;
        } else if (shouldExpandNodeInitially) {
            return shouldExpandNodeInitially;
        } else if (typeof collapsed === 'number') {
            return (_isExpanded, { level }) => level <= collapsed;
        } else {
            return AlwaysExpand;
        }
    }, [collapsed, shouldExpandNodeInitially]);
    const initialState: JsonViewerState = {
        value,
        objectSortKeys,
        indentWidth: indentWidth ?? 15,
        arrayPageSize: arrayPageSize ?? 0,
        shouldExpandNodeInitially: expandNodeInitially,
        displayObjectSize: displayObjectSize ?? true,
        collapsed: collapsed ?? false,
        enableClipboard,
        shortenTextAfterLength: shortenTextAfterLength ?? 30,
        stringEllipsis,
        onCopied,
        onExpand,
        beforeCopy,
    };
    return (
        <JsonViewerStateProvider initialState={initialState}>
            <div
                {...containerProps}
                ref={ref}
                className={`${styles.viewer}${className ? ` ${className}` : ''}`}
                data-electron-drag-region="false"
            >
                <JsonValue
                    value={value}
                    initialValue={value}
                    level={0}
                    keyName={undefined}
                    keyPath={[]}
                />
                {children}
            </div>
        </JsonViewerStateProvider>
    );
}) as unknown as JsonViewComponent;

export default JsonView;
