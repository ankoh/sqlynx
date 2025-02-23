export class Semaphore {
    protected tasks: (() => void)[] = [];
    protected count: number;

    constructor(public readonly maxConcurrency: number) {
        this.count = maxConcurrency;
    }

    async acquire(): Promise<() => void> {
        return new Promise<() => void>((resolve) => {
            const release = () => {
                this.count++;
                if (this.tasks.length > 0) {
                    const nextTask = this.tasks.shift()!;
                    nextTask();
                }
            };
            if (this.count > 0) {
                this.count--;
                resolve(release);
            } else {
                this.tasks.push(() => resolve(release));
            }
        });
    }
}
