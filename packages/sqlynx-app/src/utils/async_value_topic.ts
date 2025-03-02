type Publish<Value> = (value: Value) => void;
type Reject<Err> = (err: Err) => void;

export class AsyncValueTopic<Value> {
    protected lastValue: Value | null;
    protected nextValuePromise: Promise<Value> | null;
    protected publishNextValue: Publish<Value>;
    protected rejectNextValue: Reject<Error>;

    constructor() {
        let publishFn: Publish<Value> | null = null;
        let rejectFn: Reject<Error> | null = null;
        this.lastValue = null;
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
        this.rejectNextValue(new Error("close the channel"));
        this.resetPromise();
    }
    public publish(value: Value) {
        const pub = this.publishNextValue;
        this.resetPromise();
        this.lastValue = value;
        pub(value);
    }
    public last(): Value | null {
        return this.lastValue;
    }
    public next(): Promise<Value> {
        if (this.nextValuePromise == null) {
            this.resetPromise();
        }
        return this.nextValuePromise!;
    }
}
