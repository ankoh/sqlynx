type Resolver<Value> = (value: Value) => void;
type Rejecter<Error> = (value: Error) => void;

enum AsyncValueStatus {
    PENDING,
    RESOLVED,
    REJECTED
}

export class AsyncValue<Value, Error> {
    protected status: AsyncValueStatus;
    protected valuePromise: Promise<Value>;
    protected resolvedValue: Value | null;
    protected rejectedError: Error | null;
    protected resolveFn: Resolver<Value>;
    protected rejectFn: Rejecter<Error>;

    constructor() {
        this.status = AsyncValueStatus.PENDING;
        let resolveFn: Resolver<Value> | null = null;
        let rejectFn: Rejecter<Error> | null = null;
        this.valuePromise = new Promise<Value>((resolve, reject) => {
            resolveFn = resolve;
            rejectFn = reject
        });
        this.resolvedValue = null;
        this.rejectedError = null;
        this.resolveFn = resolveFn!;
        this.rejectFn = rejectFn!;
    }

    public isResolved(): boolean {
        return this.status == AsyncValueStatus.RESOLVED || this.status == AsyncValueStatus.REJECTED;
    }
    public async getValue(): Promise<Value> {
        switch (this.status) {
            case AsyncValueStatus.RESOLVED:
                return this.resolvedValue!;
            case AsyncValueStatus.REJECTED:
                throw this.rejectedError!;
            default:
                return await this.valuePromise;
        }
    }
    public getResolvedValue(): Value {
        switch (this.status) {
            case AsyncValueStatus.RESOLVED:
                return this.resolvedValue!;
            case AsyncValueStatus.REJECTED:
                throw this.rejectedError;
            case AsyncValueStatus.PENDING:
                throw new Error("async value is not resolved");
        }
    }
    public resolve(value: Value) {
        if (this.status != AsyncValueStatus.PENDING) {
            throw new Error("tried to resolve an async value that is not pending");
        }
        this.resolvedValue = value;
        this.status = AsyncValueStatus.RESOLVED;
        this.resolveFn(value);
    }
    public reject(error: Error) {
        if (this.status != AsyncValueStatus.PENDING) {
            throw new Error("tried to reject an async value that is not pending");
        }
        this.rejectedError = error;
        this.status = AsyncValueStatus.REJECTED;
        this.reject(error);
    }
}
