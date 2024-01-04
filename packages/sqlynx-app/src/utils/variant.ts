export type VariantKind<T, P> = {
    readonly type: T;
    readonly value: P;
};

export type Dispatch<Variant> = (action: Variant) => void;
