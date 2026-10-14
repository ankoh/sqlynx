import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { vi } from 'vitest';

import { KeyValueListBuilder } from './keyvalue_list.js';
import * as styles from './keyvalue_list.module.css';
import { LoggerProvider } from '../../platform/logger/logger_provider.js';

describe('KeyValueListBuilder', () => {
    let container: HTMLDivElement;
    let root: Root;
    const writeText = vi.fn<() => Promise<void>>(() => Promise.resolve());

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        writeText.mockClear();
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    it('renders immutable entries without mutation controls', () => {
        act(() => root.render(
            <KeyValueListBuilder
                title="Engine Settings"
                caption="Embedded engine initialization settings"
                keyIcon={() => <div>Name</div>}
                valueIcon={() => <div>Value</div>}
                addButtonLabel="Add Setting"
                elements={[
                    { key: 'identifier_resolution', value: 'case_insensitive' },
                    { key: 'log_file_max_count', value: '10' },
                ]}
                modifyElements={() => {}}
                disabled
                readOnly
            />,
        ));

        const inputs = [...container.querySelectorAll('input')];
        expect(inputs.map(input => input.value)).toEqual([
            'identifier_resolution',
            'case_insensitive',
            'log_file_max_count',
            '10',
        ]);
        expect(inputs.every(input => input.readOnly && input.disabled)).toBe(true);
        expect(container.querySelectorAll('[role="listitem"]')).toHaveLength(2);
        expect(container.querySelector('button')).toBeNull();
        expect(inputs.map(input => input.getAttribute('aria-label'))).toEqual([
            'Engine Settings name 1',
            'Engine Settings value 1',
            'Engine Settings name 2',
            'Engine Settings value 2',
        ]);
    });

    it('renders side-by-side entries without the indented connector', () => {
        act(() => root.render(
            <KeyValueListBuilder
                title="Engine Settings"
                caption="Embedded engine initialization settings"
                keyIcon={() => <div>Name</div>}
                valueIcon={() => <div>Value</div>}
                addButtonLabel="Add Setting"
                elements={[{ key: 'identifier_resolution', value: 'case_insensitive' }]}
                modifyElements={() => {}}
                disabled
                readOnly
                sideBySide
            />,
        ));

        const item = container.querySelector('[role="listitem"]');
        expect(item).not.toBeNull();
        expect(container.querySelector(`.${styles.list_side_by_side}`)).not.toBeNull();
        expect(item?.classList.contains(styles.element_side_by_side)).toBe(true);
        expect(item?.querySelector(`.${styles.aliaslink}`)).toBeNull();
        expect(item?.querySelector(`.${styles.path_side_by_side}`)).not.toBeNull();
        expect(item?.querySelector(`.${styles.alias_side_by_side}`)).not.toBeNull();
        expect(item?.querySelectorAll('input')).toHaveLength(2);
    });

    it('copies an optional formatted setting argument', async () => {
        await act(async () => root.render(
            <LoggerProvider>
                <KeyValueListBuilder
                    title="Engine Settings"
                    caption="Embedded engine initialization settings"
                    keyIcon={() => <div>Name</div>}
                    valueIcon={() => <div>Value</div>}
                    addButtonLabel="Add Setting"
                    elements={[{ key: 'identifier_resolution', value: 'case_insensitive' }]}
                    modifyElements={() => {}}
                    disabled
                    readOnly
                    sideBySide
                    copyValue={({ key, value }) => `--${key}=${value}`}
                    copyLogContext="test"
                />
            </LoggerProvider>,
        ));

        await act(async () => {
            (container.querySelector('[aria-label="Copy Engine Settings 1"]') as HTMLButtonElement).click();
            await Promise.resolve();
        });

        expect(writeText).toHaveBeenCalledWith('--identifier_resolution=case_insensitive');
    });
});
