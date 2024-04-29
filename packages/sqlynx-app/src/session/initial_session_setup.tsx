import * as React from 'react';
import { useBrainstormSessionSetup } from './setup_brainstorm_session.js';
import { useCurrentSessionSelector } from './current_session.js';

export const InitialSessionSetup: React.FC<{ children?: React.ReactElement }> = (props: { children?: React.ReactElement }) => {
    const setupBrainstormSession = useBrainstormSessionSetup();
    const selectCurrentSession = useCurrentSessionSelector();

    // Run once at the very beginning
    React.useEffect(() => {
        const run = async () => {
            const sessionId = await setupBrainstormSession();
            if (sessionId != null) {
                // Only select the brainstorm session if there's no other session set
                selectCurrentSession(s => {
                    if (s == null) {
                        return sessionId;
                    } else {
                        return s;
                    }
                });
            }
        };
        run();
    }, []);
    return props.children;
}
