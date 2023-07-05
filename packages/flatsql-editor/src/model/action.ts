export type Action<T, P> = {
    readonly type: T;
    readonly value: P;
};

export type Dispatch<ActionVariant> = (action: ActionVariant) => void;

export type ProviderProps = { children: React.ReactElement };
