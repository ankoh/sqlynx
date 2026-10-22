import * as core from '@ankoh/dashql-core';

/// The result of verifying a candidate script against the parser + analyzer.
export interface VerifyResult {
    ok: boolean;
    parserErrors: string[];
    analyzerErrors: string[];
    visualizationSpecs: number;
}

/// Verify a candidate script by parsing + analyzing it on an ephemeral scratch script.
export function verifyScript(instance: core.DashQL, catalog: core.DashQLCatalog, text: string): VerifyResult {
    const parserErrors: string[] = [];
    const analyzerErrors: string[] = [];
    let visualizationSpecs = 0;

    const script = instance.createScript(catalog);
    let parsed: core.FlatBufferPtr<core.buffers.parser.ParsedScript> | null = null;
    let analyzed: core.FlatBufferPtr<core.buffers.analyzer.AnalyzedScript> | null = null;
    try {
        script.replaceText(text);
        script.analyze();

        parsed = script.getParsed();
        analyzed = script.getAnalyzed();
        const parsedReader = parsed.read();
        const analyzedReader = analyzed.read();

        for (let i = 0; i < parsedReader.scannerErrorsLength(); ++i) {
            const message = parsedReader.scannerErrors(i)?.message();
            if (message) parserErrors.push(message);
        }
        for (let i = 0; i < parsedReader.parserErrorsLength(); ++i) {
            const message = parsedReader.parserErrors(i)?.message();
            if (message) parserErrors.push(message);
        }
        const tmpAnalyzerError = new core.buffers.analyzer.AnalyzerError();
        for (let i = 0; i < analyzedReader.errorsLength(); ++i) {
            const error = analyzedReader.errors(i, tmpAnalyzerError);
            if (!error || error.severity() === core.buffers.analyzer.AnalyzerErrorSeverity.WARNING) continue;
            const message = error.message();
            if (message) analyzerErrors.push(message);
        }
        visualizationSpecs = analyzedReader.visualizationSpecsLength();
    } catch (error: any) {
        parserErrors.push(error?.message ? String(error.message) : String(error));
    } finally {
        parsed?.destroy();
        analyzed?.destroy();
        script.destroy();
    }

    return {
        ok: parserErrors.length === 0 && analyzerErrors.length === 0,
        parserErrors,
        analyzerErrors,
        visualizationSpecs,
    };
}
