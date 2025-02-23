type Publish<Value> = (value: Value) => void;
type Reject<Err> = (err: Err) => void;

export class AsyncValueStream<Value> {
    protected nextValuePromise: Promise<Value>;
    protected publishNextValue: Publish<Value>;
    protected rejectNextValue: Reject<Error>;

    constructor() {
        let publishFn: Publish<Value> | null = null;
        let rejectFn: Reject<Error> | null = null;
        this.nextValuePromise = new Promise<Value>((resolve, reject) => {
            publishFn = resolve;
            rejectFn = reject
        });
        this.publishNextValue = publishFn!;
        this.rejectNextValue = rejectFn!;
    }

    protected resetPromise() {
        let publishFn: Publish<Value> | null = null;
        let rejectFn: Reject<Error> | null = null;
        this.nextValuePromise = new Promise<Value>((resolve, reject) => {
            publishFn = resolve;
            rejectFn = reject
        });
        this.publishNextValue = publishFn!;
        this.rejectNextValue = rejectFn!;
    }
    public close() {
        this.rejectNextValue(new Error("close the topic"));
        this.resetPromise();
    }
    public publish(value: Value) {
        const pub = this.publishNextValue;
        this.resetPromise();
        pub(value);
    }
    public nextValue(): Promise<Value> {
        return this.nextValuePromise;
    }
}
