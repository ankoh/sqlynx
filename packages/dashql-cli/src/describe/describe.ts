import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import Anthropic from '@anthropic-ai/sdk';
import type { Description } from './header.js';
import {
    DESCRIPTION_SCHEMA,
    DescribeSkipError,
    MAX_SQL_CHARS,
    SYSTEM_PROMPT,
    buildUserPrompt,
    parseDescription,
    type DescribeInput,
} from './prompt.js';

export {
    DESCRIPTION_SCHEMA,
    DescribeSkipError,
    SYSTEM_PROMPT,
    buildUserPrompt,
    parseDescription,
    type DescribeInput,
} from './prompt.js';

export const DEFAULT_DESCRIBE_MODEL = 'claude-opus-5-5';

export interface Describer {
    describe(input: DescribeInput): Promise<Description>;
}

/// Models that accept the server-side refusal fallback
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1']);

export class ClaudeDescriber implements Describer {
    private readonly client: Anthropic;

    constructor(private readonly model: string = DEFAULT_DESCRIBE_MODEL, client?: Anthropic) {
        // Credentials resolve from the environment (ANTHROPIC_API_KEY or an `ant auth login` profile)
        this.client = client ?? new Anthropic();
    }

    async describe(input: DescribeInput): Promise<Description> {
        if (input.sql.length > MAX_SQL_CHARS) {
            throw new DescribeSkipError(`script is longer than ${MAX_SQL_CHARS} characters`);
        }
        const useFallback = FALLBACK_MODELS.has(this.model);
        const response = await this.client.beta.messages.create({
            model: this.model,
            max_tokens: 2000,
            ...(useFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
            system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
            messages: [{ role: 'user', content: buildUserPrompt(input) }],
            output_config: { effort: 'low', format: { type: 'json_schema', schema: DESCRIPTION_SCHEMA } },
        });
        if (response.stop_reason === 'refusal') {
            throw new DescribeSkipError(`the model declined to describe the script (${response.stop_details?.category ?? 'refusal'})`);
        }
        if (response.stop_reason === 'max_tokens') {
            throw new DescribeSkipError('the model response was cut off');
        }
        const text = response.content.find(block => block.type === 'text');
        if (!text || text.type !== 'text') {
            throw new DescribeSkipError('the model returned no text');
        }
        return parseDescription(text.text);
    }
}

/// Runs a command with the given stdin and resolves with its stdout
export type CommandRunner = (command: string, args: string[], input: string) => Promise<string>;

const runCommand: CommandRunner = (command, args, input) =>
    new Promise((resolve, reject) => {
        // An empty working directory, so that Claude Code picks up no project instructions
        const child = spawn(command, args, { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => (stdout += chunk));
        child.stderr.on('data', chunk => (stderr += chunk));
        child.on('error', reject);
        child.on('close', code => {
            // Claude Code reports errors in its JSON result and exits with 1, the caller reads them from stdout
            if (code === 0 || stdout.trim().startsWith('{')) resolve(stdout);
            else reject(new Error(`${command} exited with ${code}: ${stderr.trim() || stdout.trim()}`));
        });
        child.stdin.end(input);
    });

/// Describes scripts through the Claude Code CLI (`claude -p`), which uses the login of Claude Code instead of an API key
export class ClaudeCodeDescriber implements Describer {
    constructor(
        private readonly model: string = DEFAULT_DESCRIBE_MODEL,
        private readonly command: string = 'claude',
        private readonly run: CommandRunner = runCommand,
    ) {}

    async describe(input: DescribeInput): Promise<Description> {
        if (input.sql.length > MAX_SQL_CHARS) {
            throw new DescribeSkipError(`script is longer than ${MAX_SQL_CHARS} characters`);
        }
        const args = [
            '--print',
            '--model', this.model,
            '--effort', 'low',
            '--tools', '',
            '--no-session-persistence',
            '--output-format', 'json',
            '--system-prompt', SYSTEM_PROMPT,
            '--json-schema', JSON.stringify(DESCRIPTION_SCHEMA),
        ];
        // The SQL goes through stdin, it may be long or start with a dash
        const stdout = await this.run(this.command, args, buildUserPrompt(input));
        let result: { is_error?: boolean; subtype?: string; result?: string; structured_output?: unknown };
        try {
            result = JSON.parse(stdout);
        } catch {
            throw new Error(`${this.command} returned no JSON result: ${stdout.trim().slice(0, 200)}`);
        }
        if (result.is_error || result.subtype !== 'success') {
            throw new Error(`${this.command}: ${result.result ?? result.subtype ?? 'unknown error'}`);
        }
        if (result.structured_output == null) {
            throw new DescribeSkipError('the model returned no structured output');
        }
        return parseDescription(JSON.stringify(result.structured_output));
    }
}
