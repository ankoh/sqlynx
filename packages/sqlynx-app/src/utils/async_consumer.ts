type Resolve<Value> = (value: Value) => void;
type Reject<Err> = (err: Err) => void;

export interface AsyncConsumer<Value> {
    resolve(value: Value): void;
    reject(err: Error): void;
}

export class AsyncConsumerLambdas<Value> implements AsyncConsumer<Value> {
    constructor(protected resolveFn: Resolve<Value> = () => { }, protected rejectFn: Reject<Error> = () => { }) { }

    resolve(value: Value): void {
        this.resolveFn(value);
    }
    reject(err: Error): void {
        this.rejectFn(err);
    }
}

