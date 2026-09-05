import { Console } from 'node:console';
import type { EventEmitter } from 'node:events';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compactAiDecisionRequest } from '../src/application/ai/ai-compact-decision-input.js';
import type { Seat } from '../src/online/types.js';
import { AiDecisionTraceRecorder } from '../src/server/services/ai-decision-trace-recorder.js';
import { runAiSelfPlay } from '../src/server/services/ai-self-play-runner.js';
import { createDeterministicDebugAiProvider } from '../src/server/services/deterministic-debug-ai-provider.js';
import { LocalInteractiveAiProvider } from '../src/server/services/local-interactive-ai-provider.js';
import {
  createSeededRandomInt,
  loadLocalSelfPlayDecks,
  LOCAL_RANDOMNESS_NOTE,
} from './ai-self-play-local-input.js';

const CARDS_PATH = fileURLToPath(new URL('../llocg_db/json/cards.json', import.meta.url));
export const MAX_INTERACTIVE_INPUT_LINE_BYTES = 64 * 1024;
const OPTIONS = new Set([
  'deck',
  'opponent-deck',
  'seat',
  'seed',
  'max-steps',
  'max-turns',
  'decision-timeout-ms',
  'max-wall-time-ms',
  'output',
  'trace-output',
]);

export function parseAiInteractiveCliArgs(args: readonly string[]) {
  const values = new Map<string, string>();
  for (const argument of args) {
    const match = /^--([^=]+)=(.+)$/.exec(argument);
    if (!match || !OPTIONS.has(match[1])) throw new Error('Unknown or invalid CLI argument');
    if (values.has(match[1])) throw new Error(`Duplicate argument: --${match[1]}`);
    values.set(match[1], match[2]);
  }
  const path = (name: string) => {
    const value = values.get(name);
    if (!value?.trim()) throw new Error(`--${name}=<path> is required`);
    return resolve(value);
  };
  const number = (name: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER) => {
    const raw = values.get(name);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(`--${name} must be an integer between ${minimum} and ${maximum}`);
    }
    return value;
  };
  const seat = values.get('seat') ?? 'FIRST';
  if (seat !== 'FIRST' && seat !== 'SECOND') throw new Error('--seat must be FIRST or SECOND');
  const deckPath = path('deck');
  return {
    deckPath,
    opponentDeckPath: values.has('opponent-deck') ? path('opponent-deck') : deckPath,
    outputPath: path('output'),
    traceOutputPath: values.has('trace-output') ? path('trace-output') : undefined,
    seat: seat as Seat,
    seed: number('seed', 0, 0xffff_ffff),
    maxSteps: number('max-steps', 1),
    maxTurns: number('max-turns', 1),
    decisionTimeoutMs: number('decision-timeout-ms', 1, 2_147_483_647) ?? 300_000,
    maxWallTimeMs: number('max-wall-time-ms', 1, 2_147_483_647) ?? 3_600_000,
  };
}

/** Buffers at most one bounded line, discarding an oversized line through its newline. */
export function createInteractiveLineReader(
  onLine: (line: string) => void,
  onOversize: () => void
) {
  let chunks: Buffer[] = [];
  let bytes = 0;
  let discarding = false;
  return (chunk: Buffer | string) => {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    while (start < data.length) {
      const newline = data.indexOf(10, start);
      const end = newline === -1 ? data.length : newline;
      const size = end - start;
      if (!discarding) {
        if (bytes + size > MAX_INTERACTIVE_INPUT_LINE_BYTES) {
          chunks = [];
          bytes = 0;
          discarding = true;
          onOversize();
        } else if (size > 0) {
          // Copy a bounded slice so a tiny pending line cannot retain an oversized input buffer.
          chunks.push(Buffer.from(data.subarray(start, end)));
          bytes += size;
        }
      }
      if (newline === -1) break;
      if (!discarding) onLine(Buffer.concat(chunks, bytes).toString('utf8').replace(/\r$/, ''));
      chunks = [];
      bytes = 0;
      discarding = false;
      start = newline + 1;
    }
  };
}

async function assertNewOutput(path: string): Promise<string> {
  try {
    await lstat(path);
    throw new Error('Refusing to overwrite an existing output');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // Parents must already exist; resolve aliases before reserving either file.
  return resolve(await realpath(dirname(path)), basename(path));
}

export interface AiInteractiveCliIo {
  input: Readable;
  output: Writable;
  signals: Pick<EventEmitter, 'on' | 'removeListener'>;
}

/** Standalone local process transport, not a server route or an account-connected session. */
export async function runAiInteractiveCli(
  args: readonly string[],
  io: AiInteractiveCliIo = { input: process.stdin, output: process.stdout, signals: process }
): Promise<void> {
  const options = parseAiInteractiveCliArgs(args);
  const output = await assertNewOutput(options.outputPath);
  const traceOutput = options.traceOutputPath
    ? await assertNewOutput(options.traceOutputPath)
    : undefined;
  if (output === traceOutput) throw new Error('Report and private trace must use separate files');
  const decks = await loadLocalSelfPlayDecks(
    options.seat === 'FIRST' ? options.deckPath : options.opponentDeckPath,
    options.seat === 'FIRST' ? options.opponentDeckPath : options.deckPath,
    CARDS_PATH
  );
  const files: FileHandle[] = [];
  let detach = () => {};
  try {
    const reportFile = await open(output, 'wx', 0o600);
    files.push(reportFile);
    const traceFile = traceOutput ? await open(traceOutput, 'wx', 0o600) : undefined;
    if (traceFile) files.push(traceFile);
    const abort = new AbortController();
    let transportFailed = false;
    const stop = () => abort.abort();
    const emit = (message: unknown, written?: () => void) => {
      if (transportFailed) {
        written?.();
        return;
      }
      try {
        if (
          !io.output.write(`${JSON.stringify(message)}\n`, (error) => {
            if (error) {
              transportFailed = true;
              stop();
            }
            written?.();
          })
        )
          io.input.pause();
      } catch {
        transportFailed = true;
        stop();
        written?.();
      }
    };
    const provider = new LocalInteractiveAiProvider({
      seat: options.seat,
      onRequest(request) {
        emit({ type: 'decision', input: compactAiDecisionRequest(request) });
      },
    });
    const inputStatus = (status: string) => emit({ type: 'input_status', status });
    const read = createInteractiveLineReader(
      (line) => {
        if (abort.signal.aborted) return;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          inputStatus('INVALID_JSON');
          return;
        }
        if (
          value !== null &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          Object.keys(value).length === 1 &&
          (value as { type?: unknown }).type === 'stop'
        ) {
          inputStatus('STOPPING');
          stop();
          return;
        }
        inputStatus(provider.submit(value).status);
      },
      () => inputStatus('LINE_TOO_LARGE')
    );
    const inputError = () => {
      inputStatus('INPUT_ERROR');
      transportFailed = true;
      stop();
    };
    const outputError = () => {
      transportFailed = true;
      stop();
    };
    const drain = () => {
      if (!abort.signal.aborted) io.input.resume();
    };
    io.input.on('data', read);
    io.input.on('end', stop);
    io.input.on('error', inputError);
    io.input.on('close', stop);
    io.output.on('error', outputError);
    io.output.on('drain', drain);
    io.signals.on('SIGINT', stop);
    detach = () => {
      provider.close();
      io.input.pause();
      io.input.removeListener('data', read);
      io.input.removeListener('end', stop);
      io.input.removeListener('error', inputError);
      io.input.removeListener('close', stop);
      io.output.removeListener('error', outputError);
      io.output.removeListener('drain', drain);
      io.signals.removeListener('SIGINT', stop);
    };
    if (io.input.readableEnded || io.input.destroyed || io.output.destroyed) stop();
    const traceRecorder = traceFile ? new AiDecisionTraceRecorder() : undefined;
    const opponent = createDeterministicDebugAiProvider();
    let report: Awaited<ReturnType<typeof runAiSelfPlay>>;
    try {
      report = await runAiSelfPlay({
        ...decks,
        providers:
          options.seat === 'FIRST'
            ? { FIRST: provider, SECOND: opponent }
            : { FIRST: opponent, SECOND: provider },
        randomInt: options.seed === undefined ? undefined : createSeededRandomInt(options.seed),
        maxSteps: options.maxSteps,
        maxTurns: options.maxTurns,
        decisionTimeoutMs: options.decisionTimeoutMs,
        maxWallTimeMs: options.maxWallTimeMs,
        signal: abort.signal,
        traceRecorder,
        onStep(step) {
          emit({ type: 'step', step });
        },
      });
    } finally {
      provider.close();
    }
    await reportFile.writeFile(
      `${JSON.stringify(
        {
          ...report,
          input: {
            deck: options.deckPath,
            opponentDeck: options.opponentDeckPath,
            cards: CARDS_PATH,
            seat: options.seat,
            seed: options.seed ?? null,
            randomnessNote: LOCAL_RANDOMNESS_NOTE,
          },
        },
        null,
        2
      )}\n`
    );
    if (traceFile && traceRecorder) {
      await traceFile.writeFile(
        `${JSON.stringify(traceRecorder.getSeatTrace(options.seat), null, 2)}\n`
      );
    }
    if (transportFailed) throw new Error('Interactive transport failed');
    const { steps, ...summary } = report;
    await new Promise<void>((written) =>
      emit({ type: 'finished', summary: { ...summary, stepCount: steps.length } }, written)
    );
    if (transportFailed) throw new Error('Interactive transport failed');
  } catch {
    // Do not echo input JSON, raw engine/provider errors, or hidden state. Reserved files
    // remain available for diagnosis and are never deleted, overwritten, or rolled back.
    throw new Error('Interactive run failed; any newly created output files were retained');
  } finally {
    detach();
    await Promise.all(files.map((file) => file.close()));
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  // Only this standalone entry owns its console. Engine diagnostics may contain authority
  // IDs or private cards; imported helpers never replace another application's console.
  globalThis.console = new Console({
    stdout: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  });
  runAiInteractiveCli(process.argv.slice(2)).catch(() => {
    process.stderr.write(
      'Interactive run failed; check arguments and new output paths. Created files were retained.\n'
    );
    process.exitCode = 1;
  });
}
