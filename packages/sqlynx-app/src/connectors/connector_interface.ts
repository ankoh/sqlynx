export interface ConnectorInterface {
    executeQuery(): Promise<void>;
    refreshSchema(): Promise<void>;
}

export const DEFAULT_CONNECTOR_INTERFACE: ConnectorInterface = {
    async executeQuery(): Promise<void> {
        console.warn('executeQuery is not implemented for this connector');
    },
    async refreshSchema(): Promise<void> {
        console.warn('refreshSchema is not implemented for this connector');
    },
};
