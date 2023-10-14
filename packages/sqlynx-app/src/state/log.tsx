// Copyright (c) 2022 The DashQL Authors

import React from 'react';
import * as Immutable from 'immutable';
import { Action, Dispatch } from '../utils/action';

const MAX_LOG_SIZE = 300;

export enum LogLevel {
    NONE = 0,
    DEBUG = 1,
    INFO = 2,
    WARNING = 3,
    ERROR = 4,
}

export enum LogOrigin {
    NONE = 0,
}

export enum LogTopic {
    NONE = 0,
}

export enum LogEvent {
    OK = 1,
    ERROR = 2,
    CAPTURE = 3,
}

export type LogEntry<O, T, E, V> = {
    readonly timestamp: Date;
    readonly level: LogLevel;
    readonly origin: O;
    readonly topic: T;
    readonly event: E;
    readonly value: V;
};

export type LogEntryVariant = LogEntry<LogOrigin.NONE, LogTopic.NONE, LogEvent.CAPTURE, any>;

export function getLogLevelLabel(level: LogLevel): string {
    switch (level) {
        case LogLevel.NONE:
            return 'NONE';
        case LogLevel.DEBUG:
            return 'DEBUG';
        case LogLevel.INFO:
            return 'INFO';
        case LogLevel.WARNING:
            return 'WARNING';
        case LogLevel.ERROR:
            return 'ERROR';
    }
}

export function getLogOriginLabel(origin: LogOrigin): string {
    switch (origin) {
        case LogOrigin.NONE:
            return 'NONE';
    }
}

export function getLogTopicLabel(topic: LogTopic): string {
    switch (topic) {
        case LogTopic.NONE:
            return 'NONE';
    }
}

export function getLogEventLabel(event: LogEvent): string {
    switch (event) {
        case LogEvent.OK:
            return 'OK';
        case LogEvent.ERROR:
            return 'ERROR';
        case LogEvent.CAPTURE:
            return 'CAPTURE';
    }
}

export type LogState = {
    /// The entries
    entries: Immutable.List<LogEntryVariant>;
};

const PUSH_LOG_ENTRY = Symbol('PUSH_LOG_ENTRY');
type LogStateAction = Action<typeof PUSH_LOG_ENTRY, LogEntryVariant>;

const initialState = {
    entries: Immutable.List<LogEntryVariant>(),
};

const reducer = (state: LogState, action: LogStateAction): LogState => {
    switch (action.type) {
        case PUSH_LOG_ENTRY:
            return {
                entries: state.entries.withMutations(list => {
                    list.unshift(action.value);
                    if (list.size > MAX_LOG_SIZE) {
                        list.pop();
                    }
                }),
            };
    }
};

export class Logger {
    _state: LogState;
    _dispatch: Dispatch<LogStateAction>;

    constructor(state: LogState, dispatch: Dispatch<LogStateAction>) {
        this._state = state;
        this._dispatch = dispatch;
    }

    /// Push a new log entry
    public log(entry: LogEntryVariant): void {
        this._dispatch({
            type: PUSH_LOG_ENTRY,
            value: entry,
        });
    }

    /// Create standalone log
    static createWired(): Logger {
        const self = new Logger(initialState, (action: LogStateAction) => {
            self._state = reducer(self._state, action);
        });
        return self;
    }
}

const LOGGER_CTX = React.createContext<Logger | null>(null);
const LOG_STATE_CTX = React.createContext<LogState | null>(null);

type ProviderProps = {
    children: React.ReactElement;
    initialState?: LogState;
};

export const LogProvider: React.FC<ProviderProps> = (props: ProviderProps) => {
    const [state, dispatch] = React.useReducer(reducer, props.initialState || initialState);
    const logger = React.useRef<Logger>(new Logger(state, dispatch));
    React.useEffect(() => {
        logger.current._state = state;
    }, [state]);
    return (
        <LOG_STATE_CTX.Provider value={state}>
            <LOGGER_CTX.Provider value={logger.current}>{props.children}</LOGGER_CTX.Provider>
        </LOG_STATE_CTX.Provider>
    );
};

export const useLogger = (): Logger => React.useContext(LOGGER_CTX)!;
export const useLogState = (): LogState => React.useContext(LOG_STATE_CTX)!;
