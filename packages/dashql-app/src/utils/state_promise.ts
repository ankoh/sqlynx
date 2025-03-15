export enum StatePromiseStatus {
    NONE,
    FAILED,
    COMPLETED,
}

export interface StatePromiseMapper<Value, Err = Error> {
    map: (value: Value) => Value;
    reject: (err: Err) => void;
}

export class StatePromise<Value, Err = Error> {
    public readonly status: StatePromiseStatus;
    public readonly value: Value | null;
    public readonly error: Err | null;
    public readonly subscribers: StatePromiseMapper<Value, Err>[];

    constructor(status: StatePromiseStatus = StatePromiseStatus.NONE, value: Value | null = null, error: Err | null = null) {
        this.status = status;
        this.value = value;
        this.error = error;
        this.subscribers = [];
    }
    public modify(sub: StatePromiseMapper<Value, Err>): StatePromise<Value, Err> {
        switch (this.status) {
            case StatePromiseStatus.NONE:
                this.subscribers.push(sub);
                return this;
            case StatePromiseStatus.FAILED:
                sub.reject(this.error!);
                return this;
            case StatePromiseStatus.COMPLETED: {
                const value = sub.map(this.value!);
                return new StatePromise<Value, Err>(this.status, value);
            }
        }
    }
    public isResolved(): boolean {
        return this.status == StatePromiseStatus.COMPLETED || this.status == StatePromiseStatus.FAILED;
    }
    public resolve(value: Value): StatePromise<Value, Err> {
        let next = value;
        for (const promise of this.subscribers) {
            next = promise.map(next);
        }
        return new StatePromise(StatePromiseStatus.COMPLETED, next);
    }
    public reject(error: Err): StatePromise<Value, Err> {
        for (const promise of this.subscribers) {
            promise.reject(error);
        }
        return new StatePromise(StatePromiseStatus.FAILED, this.value, error);
    }
}
