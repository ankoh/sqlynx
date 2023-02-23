export enum ResolvableStatus {
    NONE,
    RUNNING,
    FAILED,
    COMPLETED,
}

export type Resolver<Value> = () => Promise<Value>;

export class Resolvable<Value, Progress = null, Err = Error> {
    public readonly status: ResolvableStatus;
    public readonly value: Value;
    public readonly error: Err | null;

    constructor(status: ResolvableStatus, value: Value, error: Err | null = null) {
        this.status = status;
        this.value = value;
        this.error = error;
    }

    public resolving(): boolean {
        return this.status != ResolvableStatus.NONE;
    }
    public completeWith(value: Value): Resolvable<Value, Progress, Err> {
        return new Resolvable(ResolvableStatus.COMPLETED, value, this.error);
    }
    public failWith(error: Err): Resolvable<Value, Progress, Err> {
        return new Resolvable(ResolvableStatus.FAILED, this.value, error);
    }
}
