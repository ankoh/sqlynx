export enum ResolvableStatus {
    NONE,
    FAILED,
    COMPLETED,
}

export interface ResolvableMapper<Value, Err = Error> {
    map: (value: Value) => Value;
    reject: (err: Err) => void;
}

export class Resolvable<Value, Err = Error> {
    public readonly status: ResolvableStatus;
    public readonly value: Value | null;
    public readonly error: Err | null;
    public readonly subscribers: ResolvableMapper<Value, Err>[];

    constructor(status: ResolvableStatus = ResolvableStatus.NONE, value: Value | null = null, error: Err | null = null) {
        this.status = status;
        this.value = value;
        this.error = error;
        this.subscribers = [];
    }
    public modify(sub: ResolvableMapper<Value, Err>): Resolvable<Value, Err> {
        switch (this.status) {
            case ResolvableStatus.NONE:
                this.subscribers.push(sub);
                return this;
            case ResolvableStatus.FAILED:
                sub.reject(this.error!);
                return this;
            case ResolvableStatus.COMPLETED: {
                const value = sub.map(this.value!);
                return new Resolvable<Value, Err>(this.status, value);
            }
        }
    }
    public isResolved(): boolean {
        return this.status == ResolvableStatus.COMPLETED || this.status == ResolvableStatus.FAILED;
    }
    public resolve(value: Value): Resolvable<Value, Err> {
        let next = value;
        for (const promise of this.subscribers) {
            next = promise.map(next);
        }
        return new Resolvable(ResolvableStatus.COMPLETED, next);
    }
    public reject(error: Err): Resolvable<Value, Err> {
        for (const promise of this.subscribers) {
            promise.reject(error);
        }
        return new Resolvable(ResolvableStatus.FAILED, this.value, error);
    }
}
