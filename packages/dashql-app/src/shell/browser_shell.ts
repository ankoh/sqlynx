import type { IDisposable, Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { WebglAddon } from '@xterm/addon-webgl';

import { DashQLShell, DashQLShellPromptAction, DashQLShellPromptInput } from './api.js';
import { stringifyError } from '../platform/logger/logger.js';
import { VT100 } from './vt100.js';

const QUERY_SPINNER_INTERVAL_MS = 80;

export class TerminalQueryProgress {
    private active = false;
    private timer: ReturnType<typeof setInterval> | null = null;

    constructor(
        private readonly shell: DashQLShell,
        private readonly write: (data: string) => void,
        private readonly reducedMotion = false,
    ) { }

    update(message: string): void {
        const output = this.shell.renderTerminalQueryProgress(message);
        if (output.data.length === 0) return;
        this.active = true;
        this.write(output.data);
        if (this.timer == null && !this.reducedMotion) {
            this.timer = setInterval(() => {
                this.write(this.shell.renderTerminalQueryProgress('', true).data);
            }, QUERY_SPINNER_INTERVAL_MS);
        }
    }

    stop(): void {
        if (this.timer != null) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    clear(): void {
        this.stop();
        if (!this.active) return;
        this.active = false;
        this.write(this.shell.clearTerminalQueryProgress().data);
    }
}

export interface BrowserShellOptions {
    container: HTMLElement;
    shell: DashQLShell;
    greeter?: readonly string[];
    prompt?: string;
    onExit?: () => void;
    onQueryResult?: (queryId: number) => void;
    onTerminalResize?: (columns: number) => void;
    inputAriaLabel?: string;
}

export interface BrowserShellController {
    focus(): void;
    replaceShell(shell: DashQLShell): void;
    writeStatus(message: string): void;
    /// Offer prompts one after another, each submit fills in the next one
    queuePrompts(prompts: readonly string[]): void;
    dispose(): void;
}

export function formatQueryCompletion(rowCount: number): string {
    return `Query completed (${rowCount} ${rowCount === 1 ? 'row' : 'rows'})${VT100.NEW_LINE}`;
}

export function formatTerminalGreeter(lines: readonly string[]): string {
    if (lines.length === 0) return '';
    return VT100.ENABLE_AUTO_WRAP + VT100.BOLD + lines[0] + VT100.RESET_ATTRIBUTES + VT100.NEW_LINE +
        lines.slice(1).join(VT100.NEW_LINE) + VT100.NEW_LINE + VT100.NEW_LINE;
}

export function sanitizeTerminalText(data: string): string {
    const escape = data.indexOf(VT100.ESCAPE);
    if (escape >= 0) data = data.substring(0, escape);
    if (data.length === 1 && (data.charCodeAt(0) < 0x20 || data.charCodeAt(0) === 0x7f)) return '';
    return data
        .replace(/\r\n?/g, '\n')
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

export function isTerminalCancelData(data: string): boolean {
    return data === '\x03';
}

export function terminalPromptInputForKey(
    key: string,
    controlModifier = false,
    metaModifier = false,
    commandModifier = false,
    code = '',
): DashQLShellPromptInput | null {
    const modifierKey = code.startsWith('Key') ? code.substring(3).toLowerCase() : key.toLowerCase();
    if (metaModifier) {
        switch (modifierKey) {
            case 'backspace':
                return DashQLShellPromptInput.BACKWARD_KILL_WORD;
            case 'b':
                return DashQLShellPromptInput.WORD_LEFT;
            case 'd':
                return DashQLShellPromptInput.KILL_WORD;
            case 'f':
                return DashQLShellPromptInput.WORD_RIGHT;
        }
    }
    if (commandModifier) {
        switch (modifierKey) {
            case 'a':
                return DashQLShellPromptInput.START;
            case 'e':
                return DashQLShellPromptInput.END;
        }
    }
    if (controlModifier) {
        switch (modifierKey) {
            case 'a':
                return DashQLShellPromptInput.LINE_START;
            case 'b':
                return DashQLShellPromptInput.LEFT;
            case 'd':
                return DashQLShellPromptInput.EOF;
            case 'e':
                return DashQLShellPromptInput.LINE_END;
            case 'f':
                return DashQLShellPromptInput.RIGHT;
            case 'g':
                return DashQLShellPromptInput.ABORT;
            case 'h':
                return DashQLShellPromptInput.BACKSPACE;
            case 'i':
                return DashQLShellPromptInput.TAB;
            case 'j':
                return DashQLShellPromptInput.ENTER;
            case 'k':
                return DashQLShellPromptInput.KILL_LINE;
            case 'l':
                return DashQLShellPromptInput.CLEAR_SCREEN;
            case 'm':
                return DashQLShellPromptInput.ENTER;
            case 'n':
                return DashQLShellPromptInput.HISTORY_NEXT;
            case 'p':
                return DashQLShellPromptInput.HISTORY_PREVIOUS;
            case 't':
                return DashQLShellPromptInput.TRANSPOSE;
            case 'u':
                return DashQLShellPromptInput.BACKWARD_KILL_LINE;
            case 'w':
                return DashQLShellPromptInput.BACKWARD_KILL_WORD;
            case 'y':
                return DashQLShellPromptInput.YANK;
        }
    }
    switch (key) {
        case 'Enter':
            return DashQLShellPromptInput.ENTER;
        case 'Tab':
            return DashQLShellPromptInput.TAB;
        case 'Backspace':
            return DashQLShellPromptInput.BACKSPACE;
        case 'Delete':
            return DashQLShellPromptInput.DELETE;
        case 'ArrowLeft':
            return DashQLShellPromptInput.LEFT;
        case 'ArrowRight':
            return DashQLShellPromptInput.RIGHT;
        case 'ArrowUp':
            return DashQLShellPromptInput.UP;
        case 'ArrowDown':
            return DashQLShellPromptInput.DOWN;
        case 'Home':
            return DashQLShellPromptInput.START;
        case 'End':
            return DashQLShellPromptInput.END;
        case 'Escape':
            return DashQLShellPromptInput.ESCAPE;
        default:
            return null;
    }
}

export async function loadWebglRenderer(terminal: Terminal): Promise<boolean> {
    try {
        const { WebglAddon } = await import('@xterm/addon-webgl');
        const webglAddon: WebglAddon = new WebglAddon();
        terminal.loadAddon(webglAddon);
        webglAddon.onContextLoss(() => webglAddon.dispose());
        return true;
    } catch {
        // xterm's DOM renderer remains active when WebGL is unavailable.
        return false;
    }
}

/// The color of the shell prompt as 0xRRGGBB, from the `--shell_prompt_color` theme token of an element.
/// Null if the theme leaves it unset, the prompt is then bold in the default foreground color.
export function resolveShellPromptColor(element: HTMLElement): number | null {
    const token = getComputedStyle(element).getPropertyValue('--shell_prompt_color').trim();
    if (token === '' || !CSS.supports('color', token)) return null;
    // Let the browser resolve the color to rgb()
    const probe = document.createElement('span');
    probe.style.color = token;
    element.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
    return match == null ? null : (Number(match[1]) << 16) | (Number(match[2]) << 8) | Number(match[3]);
}

export async function embedDashQLShell(options: BrowserShellOptions): Promise<BrowserShellController> {
    const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/xterm/css/xterm.css'),
    ]) as [{ Terminal: typeof import('@xterm/xterm').Terminal }, { FitAddon: typeof import('@xterm/addon-fit').FitAddon }, unknown];

    let shell = options.shell;
    let activeQuery: AbortController | null = null;
    let activeProgress: TerminalQueryProgress | null = null;
    let disposed = false;
    let pendingPrompts: string[] = [];
    const prompt = options.prompt ?? 'dashql> ';
    const promptColor = resolveShellPromptColor(options.container);
    const terminal: Terminal = new Terminal({
        allowProposedApi: false,
        allowTransparency: true,
        convertEol: true,
        cursorBlink: true,
        cursorStyle: 'block',
        fontFamily: 'Roboto Mono, monospace',
        fontSize: 13,
        screenReaderMode: true,
        scrollback: 10000,
        theme: {
            background: '#00000000',
            foreground: '#e6edf3',
            cursor: '#ffffff',
            selectionBackground: '#264f78',
        },
    });
    const fitAddon: FitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(options.container);
    await loadWebglRenderer(terminal);
    const helper = options.container.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
    helper?.setAttribute('aria-label', options.inputAriaLabel ?? 'DashQL shell input');

    const syncSize = () => {
        if (disposed || options.container.clientWidth === 0 || options.container.clientHeight === 0) return;
        fitAddon.fit();
        const columns = Math.max(1, terminal.cols);
        shell.resize(columns);
        options.onTerminalResize?.(columns);
    };
    const resizeObserver = new ResizeObserver(syncSize);
    resizeObserver.observe(options.container);

    const submit = async () => {
        if (activeQuery != null) return;
        const abort = new AbortController();
        const executingShell = shell;
        const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
        const progress = new TerminalQueryProgress(executingShell, data => terminal.write(data), reducedMotion);
        const queryResult: { value: { queryId: number; rowCount: number } | null } = { value: null };
        activeQuery = abort;
        activeProgress = progress;
        try {
            const output = await executingShell.submitPrompt(
                abort.signal,
                message => {
                    if (!disposed && shell === executingShell && activeQuery === abort) progress.update(message);
                },
                (queryId, rowCount) => {
                    if (!disposed && shell === executingShell && activeQuery === abort) {
                        queryResult.value = { queryId, rowCount };
                    }
                },
            );
            if (!disposed && shell === executingShell) {
                progress.stop();
                const completedResult = queryResult.value;
                terminal.write(executingShell.finishTerminalQuery(
                    completedResult == null ? output : formatQueryCompletion(completedResult.rowCount),
                ).data);
                if (completedResult != null) options.onQueryResult?.(completedResult.queryId);
            }
        } catch (error) {
            if (!disposed && shell === executingShell) {
                progress.stop();
                terminal.write(executingShell.finishTerminalQuery(stringifyError(error), true).data);
            }
        } finally {
            progress.stop();
            if (activeProgress === progress) activeProgress = null;
            if (activeQuery === abort) activeQuery = null;
            if (!disposed && shell === executingShell) fillNextPrompt();
        }
    };
    const consume = (key: DashQLShellPromptInput, text = '') => {
        if (key === DashQLShellPromptInput.CANCEL) pendingPrompts = [];
        const output = shell.consumeTerminalInput(key, text);
        terminal.write(output.data);
        if (output.action === DashQLShellPromptAction.SUBMIT) void submit();
        else if (output.action === DashQLShellPromptAction.EXIT) options.onExit?.();
    };
    // Inserting text never submits, the user runs every queued prompt with Enter
    const fillNextPrompt = () => {
        if (activeQuery != null) return;
        const next = pendingPrompts.shift();
        if (next != null) consume(DashQLShellPromptInput.TEXT, next);
    };

    terminal.attachCustomKeyEventHandler(event => {
        if (event.type !== 'keydown') return true;
        if (event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'c') {
            if (activeQuery != null) activeQuery.abort();
            else consume(DashQLShellPromptInput.CANCEL);
            event.preventDefault();
            event.stopPropagation();
            return false;
        }
        let key = terminalPromptInputForKey(
            event.key,
            event.ctrlKey && !event.altKey && !event.metaKey,
            event.altKey && !event.ctrlKey && !event.metaKey,
            event.metaKey && !event.altKey && !event.ctrlKey,
            event.code,
        );
        if (event.key === 'Enter') {
            if (event.ctrlKey || event.metaKey) key = DashQLShellPromptInput.FORCE_SUBMIT;
            else if (event.shiftKey) {
                if (activeQuery == null) consume(DashQLShellPromptInput.TEXT, '\n');
                event.preventDefault();
                event.stopPropagation();
                return false;
            }
        }
        if (key == null) return true;
        if (activeQuery == null) consume(key);
        event.preventDefault();
        event.stopPropagation();
        return false;
    });

    const dataSubscription: IDisposable = terminal.onData(data => {
        if (disposed || activeQuery != null) return;
        if (isTerminalCancelData(data)) {
            consume(DashQLShellPromptInput.CANCEL);
            return;
        }
        const text = sanitizeTerminalText(data);
        if (text.length > 0) consume(DashQLShellPromptInput.TEXT, text);
    });

    shell.setTerminalPromptColor(promptColor);
    terminal.write(options.greeter == null
        ? shell.openTerminal(prompt).data
        : formatTerminalGreeter(options.greeter) + shell.openTerminal(prompt).data);
    requestAnimationFrame(() => {
        syncSize();
        terminal.focus();
    });

    return {
        focus: () => terminal.focus(),
        replaceShell(nextShell) {
            const history = shell.exportHistory();
            pendingPrompts = [];
            activeProgress?.clear();
            activeProgress = null;
            activeQuery?.abort();
            shell = nextShell;
            shell.importHistory(history);
            shell.setTerminalPromptColor(promptColor);
            terminal.write(shell.openTerminal(prompt).data);
            syncSize();
        },
        writeStatus(message) {
            terminal.write(shell.renderTerminalStatus(message).data);
        },
        queuePrompts(prompts) {
            if (disposed) return;
            pendingPrompts = [...prompts];
            fillNextPrompt();
        },
        dispose() {
            if (disposed) return;
            pendingPrompts = [];
            activeProgress?.clear();
            activeProgress = null;
            disposed = true;
            activeQuery?.abort();
            dataSubscription.dispose();
            resizeObserver.disconnect();
            terminal.dispose();
        },
    };
}
