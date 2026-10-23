import { install, type Clock } from '@sinonjs/fake-timers';
import {
    ASYMMETRIC_MATCHERS_OBJECT,
    ChaiStyleAssertions,
    GLOBAL_EXPECT,
    JestAsymmetricMatchers,
    JestChaiExpect,
    JestExtend,
    chai,
    setState,
    type Assertion,
    type ExpectStatic,
    type MatcherState,
} from '@vitest/expect';
import {
    clearAllMocks,
    fn,
    resetAllMocks,
    restoreAllMocks,
    spyOn,
} from '@vitest/spy';
import { getBrowserMocha } from './mocha_browser.js';
import { act } from './react_act.js';

getBrowserMocha();

type BrowserMochaTest = { timeout(milliseconds: number): BrowserMochaTest };
type BrowserMochaTestFunction = {
    (title: string, test?: TestFunction): BrowserMochaTest | undefined;
    skip: BrowserMochaTestFunction;
    only: BrowserMochaTestFunction;
};
type BrowserMochaSuiteFunction = {
    (title: string, suite?: TestFunction): unknown;
    skip: BrowserMochaSuiteFunction;
    only: BrowserMochaSuiteFunction;
};
type BrowserMochaHook = (test: TestFunction) => unknown;

declare global {
    var __DASHQL_CURRENT_TEST_FILE__: string | undefined;
    var __DASHQL_SET_CURRENT_TEST_FILE__: (file: string) => void;
}

const {
    after: mochaAfterAll,
    afterEach: mochaAfterEach,
    before: mochaBeforeAll,
    beforeEach: mochaBeforeEach,
    describe: mochaDescribe,
    it: mochaIt,
} = globalThis as typeof globalThis & {
    after: BrowserMochaHook;
    afterEach: BrowserMochaHook;
    before: BrowserMochaHook;
    beforeEach: BrowserMochaHook;
    describe: BrowserMochaSuiteFunction;
    it: BrowserMochaTestFunction;
};

interface BrowserMochaContext {
    after: BrowserMochaHook;
    afterEach: BrowserMochaHook;
    before: BrowserMochaHook;
    beforeEach: BrowserMochaHook;
    describe: BrowserMochaSuiteFunction;
    it: BrowserMochaTestFunction;
}

const rootContext: BrowserMochaContext = {
    after: mochaAfterAll,
    afterEach: mochaAfterEach,
    before: mochaBeforeAll,
    beforeEach: mochaBeforeEach,
    describe: mochaDescribe,
    it: mochaIt,
};

mochaAfterEach(() => {
    act(() => {});
});

const fileContexts = new Map<string, BrowserMochaContext>();

globalThis.__DASHQL_SET_CURRENT_TEST_FILE__ = (file: string) => {
    globalThis.__DASHQL_CURRENT_TEST_FILE__ = file;
    if (fileContexts.has(file)) return;
    const suite = globalThis.Mocha.Suite.create(getBrowserMocha().suite, file);
    suite.__dashqlFile = file;
    globalThis.Mocha.interfaces.bdd(suite);
    const context = {} as BrowserMochaContext;
    suite.emit(globalThis.Mocha.Suite.constants.EVENT_FILE_PRE_REQUIRE, context, file, getBrowserMocha());
    fileContexts.set(file, context);
};

function currentContext(): BrowserMochaContext {
    return globalThis.__DASHQL_CURRENT_TEST_FILE__
        ? fileContexts.get(globalThis.__DASHQL_CURRENT_TEST_FILE__) ?? rootContext
        : rootContext;
}

chai.use(JestExtend);
chai.use(JestChaiExpect);
chai.use(ChaiStyleAssertions);
chai.use(JestAsymmetricMatchers);

const expect = ((value: unknown, message?: string): Assertion => {
    return chai.expect(value, message) as unknown as Assertion;
}) as ExpectStatic;
Object.assign(expect, chai.expect, (globalThis as any)[ASYMMETRIC_MATCHERS_OBJECT]);
setState<MatcherState>({ assertionCalls: 0 }, expect);
Object.defineProperty(globalThis, GLOBAL_EXPECT, {
    configurable: true,
    value: expect,
    writable: true,
});

type TestFunction = (...args: any[]) => any;
type TestOptions = number | { timeout?: number };

function formatCaseTitle(template: string, values: unknown[], index: number): string {
    let valueIndex = 0;
    return template
        .replace(/\$([\w.]+)/g, (_, path: string) => {
            const value = path.split('.').reduce<unknown>((current, key) => {
                return current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined;
            }, values[0]);
            return String(value);
        })
        .replace(/%[sdifjo#]/g, token => {
            if (token === '%#') return String(index);
            return String(values[valueIndex++]);
        });
}

function registerTest(
    kind: 'normal' | 'skip' | 'only',
    title: string,
    optionsOrTest?: TestOptions | TestFunction,
    maybeTest?: TestFunction,
): BrowserMochaTest | undefined {
        const it = currentContext().it;
        const base = kind === 'normal' ? it : it[kind];
        if (typeof optionsOrTest === 'function' || optionsOrTest == null) {
            return base(title, optionsOrTest as TestFunction);
        }
        const test = base(title, maybeTest!);
        const timeout = typeof optionsOrTest === 'number' ? optionsOrTest : optionsOrTest.timeout;
        if (timeout != null && test) test.timeout(timeout);
        return test;
}

function createTestFunction(kind: 'normal' | 'skip' | 'only'): BrowserMochaTestFunction {
    return ((title: string, optionsOrTest?: TestOptions | TestFunction, maybeTest?: TestFunction) =>
        registerTest(kind, title, optionsOrTest, maybeTest)) as BrowserMochaTestFunction;
}

const it = createTestFunction('normal') as BrowserMochaTestFunction & {
        each: (cases: readonly unknown[]) => (title: string, test: TestFunction) => void;
};
it.skip = createTestFunction('skip');
it.only = createTestFunction('only');
it.each = (cases: readonly unknown[]) => {
        return (title: string, test: TestFunction) => {
            cases.forEach((testCase, index) => {
                const values = Array.isArray(testCase) ? testCase : [testCase];
                it(formatCaseTitle(title, values, index), () => test(...values));
            });
        };
};

const test = it as typeof import('vitest').it;
const describe = ((title: string, suite?: TestFunction) => currentContext().describe(title, suite)) as BrowserMochaSuiteFunction;
describe.skip = ((title, suite) => currentContext().describe.skip(title, suite)) as BrowserMochaSuiteFunction;
describe.only = ((title, suite) => currentContext().describe.only(title, suite)) as BrowserMochaSuiteFunction;
const beforeAll = ((test: TestFunction) => currentContext().before(test)) as BrowserMochaHook;
const afterAll = ((test: TestFunction) => currentContext().after(test)) as BrowserMochaHook;
const beforeEach = ((test: TestFunction) => currentContext().beforeEach(test)) as BrowserMochaHook;
const afterEach = ((test: TestFunction) => currentContext().afterEach(test)) as BrowserMochaHook;

let clock: Clock | null = null;
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();

function stubGlobal(name: string, value: unknown): void {
    if (!originalGlobals.has(name)) {
        originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    }
    Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
}

function unstubAllGlobals(): void {
    for (const [name, descriptor] of originalGlobals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete (globalThis as Record<string, unknown>)[name];
    }
    originalGlobals.clear();
}

async function waitFor(assertion: () => unknown, options?: { interval?: number; timeout?: number }): Promise<void> {
    const interval = options?.interval ?? 10;
    const timeout = options?.timeout ?? 1000;
    const deadline = performance.now() + timeout;
    for (;;) {
        // Check after every wait, a busy event loop may delay the last wait past the deadline.
        const expired = performance.now() >= deadline;
        try {
            await assertion();
            return;
        } catch (error) {
            if (expired) throw error;
        }
        await new Promise(resolve => setTimeout(resolve, interval));
    }
}

function unsupportedModuleMocking(): never {
    throw new Error('vi.mock() is not available in the static browser runner; inject the dependency explicitly');
}

const vi = {
    advanceTimersByTime: (milliseconds: number) => clock?.tick(milliseconds),
    clearAllMocks,
    fn,
    hoisted: <T>(factory: () => T): T => factory(),
    mock: unsupportedModuleMocking,
    mocked: <T>(value: T): T => value,
    resetAllMocks,
    restoreAllMocks,
    runAllTimers: () => clock?.runAll(),
    spyOn,
    stubGlobal,
    unstubAllGlobals,
    useFakeTimers: () => {
        clock?.uninstall();
        clock = install();
        return vi;
    },
    useRealTimers: () => {
        clock?.uninstall();
        clock = null;
        return vi;
    },
    waitFor,
};

Object.assign(globalThis, {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    test,
    vi,
});

export {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    test,
    vi,
};
