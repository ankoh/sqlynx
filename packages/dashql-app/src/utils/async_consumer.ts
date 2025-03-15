type Resolve<Context, Value> = (ctx: Context, value: Value) => void;
type Reject<Context, Err> = (ctx: Context, err: Err) => void;

export interface AsyncConsumer<Context, Value> {
    resolve(ctx: Context, value: Value): void;
    reject(ctx: Context, err: Error): void;
}

export class AsyncConsumerLambdas<Context, Value> implements AsyncConsumer<Context, Value> {
    constructor(protected resolveFn: Resolve<Context, Value> = () => { }, protected rejectFn: Reject<Context, Error> = () => { }) { }

    resolve(ctx: Context, value: Value): void {
        try {
            this.resolveFn(ctx, value);
        } catch (e: any) {
            console.warn(`AsyncConsumerLambdas::resolveFn threw error: ${e}`);
        }
    }
    reject(ctx: Context, err: Error): void {
        try {
            this.rejectFn(ctx, err);
        } catch (e: any) {
            console.warn(`AsyncConsumerLambdas::rejectFn threw error: ${e}`);
        }
    }
}

