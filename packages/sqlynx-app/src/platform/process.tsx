import * as React from 'react';
import * as process from "@tauri-apps/plugin-process";

import { Logger } from './logger.js';
import { isNativePlatform } from './native_globals.js';
import { useLogger } from './logger_provider.js';

export interface ProcessApi {
    relaunch(): Promise<void>;
}

class NativeProcess implements ProcessApi {
    logger: Logger;
    constructor(logger: Logger) {
        this.logger = logger;
    }
    async relaunch(): Promise<void> {
        this.logger.info("relaunching");
        await process.relaunch();
    }
}

class WebProcess implements ProcessApi {
    logger: Logger;
    constructor(logger: Logger) {
        this.logger = logger;
    }
    async relaunch(): Promise<void> {
        this.logger.info("relaunching");
        window.location.reload();
    }
}

const PROCESS_CTX = React.createContext<ProcessApi | null>(null);
export const useProcess = () => React.useContext(PROCESS_CTX)!;

interface ProcessProviderProps {
    children: React.ReactElement;
}

export const ProcessProvider: React.FC<ProcessProviderProps> = (props: ProcessProviderProps) => {
    const logger = useLogger();
    const process = isNativePlatform() ? new NativeProcess(logger) : new WebProcess(logger);
    return (
        <PROCESS_CTX.Provider value={process}>
            {props.children}
        </PROCESS_CTX.Provider>
    );
};
