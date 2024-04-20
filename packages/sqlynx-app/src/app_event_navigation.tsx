import * as proto from '@ankoh/sqlynx-pb';
import * as React from 'react';

import { useNavigate } from 'react-router-dom';
import { useAppEventListener } from './platform/event_listener_provider.js';

type Props = {
    children: React.ReactElement;
};

export const AppEventNavigation: React.FC<Props> = (props: Props) => {
    const navigate = useNavigate();
    const appEvents = useAppEventListener();
    const handleNav = React.useCallback((event: proto.sqlynx_app_event.pb.NavigateTo) => {
        const params = new URLSearchParams(event.searchParams);
        navigate(`${event.path}?${params.toString()}`);
    }, [navigate]);
    React.useEffect(() => {
        appEvents.subscribeNavigationEvents(handleNav);
    }, []);
    return props.children;
};

