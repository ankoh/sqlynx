import * as React from 'react';
import * as renderer from "react-test-renderer";

import { Dispatch } from "../utils/variant.js";
import { SetConnectionAction, createConnectionId, useOrCreateConnectionState } from "./connection_manager.js";
import { SALESFORCE_DATA_CLOUD } from "./connector_info.js";
import { ConnectionState, SalesforceConnectorState, createEmptyTimings } from "./connection_state.js";
import { AUTH_FLOW_DEFAULT_STATE } from "./salesforce_auth_state.js";


describe('Connection Manager', () => {
    it("returns monotonic increasing connection ids", async () => {
        const first = createConnectionId();
        const second = createConnectionId();
        const third = createConnectionId();
        expect(first).toBeLessThan(second);
        expect(second).toBeLessThan(third);
    });

    it("constructor works", async () => {
        const cid = createConnectionId();
        const given: ConnectionState = {
            type: SALESFORCE_DATA_CLOUD,
            value: {
                timings: createEmptyTimings(),
                auth: AUTH_FLOW_DEFAULT_STATE
            }
        };
        let receivedState: SalesforceConnectorState | null = null;
        let receivedDispatch: Dispatch<SetConnectionAction<SalesforceConnectorState>>;

        const Test: React.FC<{}> = (_props: {}) => {
            [receivedState, receivedDispatch] = useOrCreateConnectionState(cid, () => given);
            return <div />;
        };
        renderer.create(<Test />);

        expect(receivedState).toEqual(given.value);
    });
});
