import { describe, expect, it, vi } from 'vitest';

import { SET_SCRIPT_TEXT, type ScriptData } from '../scripts/session_scripts.js';
import { persistDashboardPlacement } from './dashboard_source.js';

describe('dashboard source persistence', () => {
    it('delegates placement rewrites to the core script session', () => {
        const rewriteDashboard = vi.fn(() => 'rewritten sql');
        const modify = vi.fn();
        const script = {
            scriptKey: 7,
            scriptSession: { rewriteDashboard },
        } as unknown as ScriptData;

        persistDashboardPlacement(script, { id: 7, row: 2, column: 4, width: 5, height: 3 }, modify);

        expect(rewriteDashboard).toHaveBeenCalledWith(2, 4, 5, 3);
        expect(modify).toHaveBeenCalledWith({
            type: SET_SCRIPT_TEXT,
            value: { scriptKey: 7, text: 'rewritten sql' },
        });
    });
});
