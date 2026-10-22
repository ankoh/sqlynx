import type { ModifySessionScripts } from '../scripts/session_scripts_registry.js';
import { SET_SCRIPT_TEXT, type ScriptData } from '../scripts/session_scripts.js';
import type { DashboardPlacement } from './dashboard_layout.js';

export function persistDashboardPlacement(
    script: ScriptData,
    placement: DashboardPlacement,
    modifySessionScripts: ModifySessionScripts,
): void {
    modifySessionScripts({
        type: SET_SCRIPT_TEXT,
        value: {
            scriptKey: script.scriptKey,
            text: script.scriptSession.rewriteDashboard(
                placement.row,
                placement.column,
                placement.width,
                placement.height,
            ),
        },
    });
}
