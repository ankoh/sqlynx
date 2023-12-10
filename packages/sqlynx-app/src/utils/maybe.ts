export enum MaybeStatus {
    NONE,
    RUNNING,
    FAILED,
    COMPLETED,
}

export class Maybe<Value, Progress = null, Err = Error> {
    public readonly status: MaybeStatus;
    public readonly value: Value | null;
    public readonly error: Err | null;

    constructor(status: MaybeStatus, value: Value | null = null, error: Err | null = null) {
        this.status = status;
        this.value = value;
        this.error = error;
    }

    public isResolved(): boolean {
        return this.status == MaybeStatus.COMPLETED || this.status == MaybeStatus.FAILED;
    }
    public completeWith(value: Value): Maybe<Value, Progress, Err> {
        return new Maybe(MaybeStatus.COMPLETED, value, this.error);
    }
    public failWith(error: Err): Maybe<Value, Progress, Err> {
        return new Maybe(MaybeStatus.FAILED, this.value, error);
    }
}
