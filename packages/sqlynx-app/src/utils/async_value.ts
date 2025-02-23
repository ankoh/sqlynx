type Resolver<Value> = (value: Value) => void;
type Rejecter<Error> = (value: Error) => void;

enum AsyncConsumerValueStatus {
    PENDING,
    RESOLVED,
    REJECTED
}

export class AsyncConsumerValue<Value, Error> {
    protected status: AsyncConsumerValueStatus;
    protected valuePromise: Promise<Value>;
    protected resolvedValue: Value | null;
    protected rejectedError: Error | null;
    protected resolveFn: Resolver<Value>;
    protected rejectFn: Rejecter<Error>;

    constructor() {
        this.status = AsyncConsumerValueStatus.PENDING;
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
        return this.status == AsyncConsumerValueStatus.RESOLVED || this.status == AsyncConsumerValueStatus.REJECTED;
    }
    public async getValue(): Promise<Value> {
        switch (this.status) {
            case AsyncConsumerValueStatus.RESOLVED:
                return this.resolvedValue!;
            case AsyncConsumerValueStatus.REJECTED:
                throw this.rejectedError!;
            default:
                return await this.valuePromise;
        }
    }
    public getResolvedValue(): Value {
        switch (this.status) {
            case AsyncConsumerValueStatus.RESOLVED:
                return this.resolvedValue!;
            case AsyncConsumerValueStatus.REJECTED:
                throw this.rejectedError;
            case AsyncConsumerValueStatus.PENDING:
                throw new Error("async value is not resolved");
        }
    }
    public resolve(value: Value) {
        if (this.status != AsyncConsumerValueStatus.PENDING) {
            throw new Error("tried to resolve an async value that is not pending");
        }
        this.resolvedValue = value;
        this.status = AsyncConsumerValueStatus.RESOLVED;
        this.resolveFn(value);
    }
    public reject(error: Error) {
        if (this.status != AsyncConsumerValueStatus.PENDING) {
            throw new Error("tried to reject an async value that is not pending");
        }
        this.rejectedError = error;
        this.status = AsyncConsumerValueStatus.REJECTED;
        this.reject(error);
    }
}
