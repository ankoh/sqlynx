import { describe, expect, it } from 'vitest';

import { reconcileSessionScripts, remapSessionScripts, sanitizeSessionFiles, sessionAttachments } from './session_files.js';
import { TEST_CONNECTION_ID, testSession } from './session_test_backend.js';

const OTHER_CONNECTION_ID = 'ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb';

describe('session file lists', () => {
    it('keeps the order of the listed scripts and appends unlisted files in natural order', () => {
        const result = reconcileSessionScripts([
            { name: '10_b.sql', connectionId: OTHER_CONNECTION_ID },
            { name: 'missing.sql', connectionId: TEST_CONNECTION_ID },
            { name: '2_a.sql', connectionId: TEST_CONNECTION_ID },
        ], ['2_a.sql', '10_b.sql', '3_new.sql', '20_new.sql'], TEST_CONNECTION_ID);
        expect(result).toEqual({
            scripts: [
                { name: '10_b.sql', connectionId: OTHER_CONNECTION_ID },
                { name: '2_a.sql', connectionId: TEST_CONNECTION_ID },
                { name: '3_new.sql', connectionId: TEST_CONNECTION_ID },
                { name: '20_new.sql', connectionId: TEST_CONNECTION_ID },
            ],
            changed: true,
        });
    });

    it('reports an unchanged list and follows the case of the files', () => {
        const scripts = [{ name: 'a.sql', connectionId: TEST_CONNECTION_ID }];
        expect(reconcileSessionScripts(scripts, ['a.sql'], TEST_CONNECTION_ID)).toEqual({ scripts, changed: false });
        expect(reconcileSessionScripts([...scripts, { name: 'A.SQL', connectionId: OTHER_CONNECTION_ID }], ['A.sql'], TEST_CONNECTION_ID))
            .toEqual({ scripts: [{ name: 'A.sql', connectionId: TEST_CONNECTION_ID }], changed: true });
    });

    it('drops unusable entries of a hand-edited session file', () => {
        const files = sanitizeSessionFiles(testSession({
            scripts: [
                { name: '../escape.sql', connectionId: TEST_CONNECTION_ID },
                { name: 'dashql-draft.sql', connectionId: TEST_CONNECTION_ID },
                { name: 'notes.txt', connectionId: TEST_CONNECTION_ID },
                { name: 'a.sql', connectionId: 'not-a-uuid' },
                { name: 'b.sql', connectionId: TEST_CONNECTION_ID },
                { name: 'B.sql', connectionId: TEST_CONNECTION_ID },
            ],
            attachments: [{ name: '10.csv' }, { name: '2.csv' }, { name: 'a/b.csv' }],
        }));
        expect(files).toEqual({
            scripts: [{ name: 'b.sql', connectionId: TEST_CONNECTION_ID }],
            attachments: [{ name: '2.csv' }, { name: '10.csv' }],
            valid: false,
        });
        expect(sanitizeSessionFiles(testSession()).valid).toBe(true);
        expect(sanitizeSessionFiles({ ...testSession(), scripts: undefined } as any)).toMatchObject({ scripts: [], valid: false });
    });

    it('sorts attachments and remaps the connections of scripts', () => {
        expect(sessionAttachments(['10.csv', '2.csv'])).toEqual([{ name: '2.csv' }, { name: '10.csv' }]);
        expect(remapSessionScripts([
            { name: 'a.sql', connectionId: TEST_CONNECTION_ID },
            { name: 'b.sql', connectionId: OTHER_CONNECTION_ID },
        ], new Map([[TEST_CONNECTION_ID, 'new']]))).toEqual([
            { name: 'a.sql', connectionId: 'new' },
            { name: 'b.sql', connectionId: OTHER_CONNECTION_ID },
        ]);
    });
});
