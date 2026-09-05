import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadLocalSelfPlayDecks } from '../../scripts/ai-self-play-local-input.js';
import {
  createInteractiveLineReader,
  MAX_INTERACTIVE_INPUT_LINE_BYTES,
  parseAiInteractiveCliArgs,
  runAiInteractiveCli,
} from '../../scripts/run-ai-interactive.js';
import type { AiDecisionRequestV2 } from '../../src/application/ai/ai-decision-contract.js';
import type { Seat } from '../../src/online/types.js';
import { AiDecisionTraceRecorder } from '../../src/server/services/ai-decision-trace-recorder.js';
import {
  runAiSelfPlay,
  type AiSelfPlayReport,
} from '../../src/server/services/ai-self-play-runner.js';
import { LocalInteractiveAiProvider } from '../../src/server/services/local-interactive-ai-provider.js';
import { CardType, GamePhase, SubPhase } from '../../src/shared/types/enums.js';

vi.mock('../../src/server/services/ai-self-play-runner.js', () => ({ runAiSelfPlay: vi.fn() }));
vi.mock('../../scripts/ai-self-play-local-input.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../scripts/ai-self-play-local-input.js')>()),
  loadLocalSelfPlayDecks: vi.fn(),
}));

const TEMP_DIRS: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'loveca-interactive-cli-'));
  TEMP_DIRS.push(path);
  return path;
}
const REPORT: AiSelfPlayReport = {
  schemaVersion: 1,
  status: 'LIMIT_REACHED',
  stopReason: 'MAX_STEPS',
  final: null,
  steps: [],
  wallTimeMs: 2,
  providerTimeMs: 1,
  virtualWaitMs: 0,
  blocker: null,
};
function request(seat: Seat = 'FIRST'): AiDecisionRequestV2 {
  return {
    schemaVersion: 2,
    decisionId: 'd1',
    contextDigest: 'digest1',
    observation: {
      match: {
        viewerSeat: seat,
        turnCount: 0,
        phase: 'MULLIGAN',
        subPhase: 'MULLIGAN',
        firstSeat: 'FIRST',
        activeSeat: null,
        prioritySeat: seat,
        publicSequence: 0,
        window: null,
      },
      zoneCounts: [],
    },
    window: {
      kind: 'MULLIGAN',
      minSelections: 0,
      maxSelections: 1,
      candidates: [
        { token: 'c1', card: { cardCode: `VISIBLE_${seat}`, cardType: CardType.MEMBER } },
      ],
    },
  };
}
function answer(input = request()) {
  return {
    schemaVersion: 2,
    decisionId: input.decisionId,
    contextDigest: input.contextDigest,
    kind: 'MULLIGAN',
    selectedCardTokens: [],
  };
}
function io(onMessage?: (value: Record<string, unknown>, input: PassThrough) => void) {
  const input = new PassThrough();
  const messages: Array<Record<string, unknown>> = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      const value = JSON.parse(String(chunk)) as Record<string, unknown>;
      messages.push(value);
      globalThis.queueMicrotask(() => onMessage?.(value, input));
      callback();
    },
  });
  return { input, output, signals: new EventEmitter(), messages };
}
beforeEach(() => {
  vi.mocked(loadLocalSelfPlayDecks).mockResolvedValue({
    firstDeck: { mainDeck: [], energyDeck: [] },
    secondDeck: { mainDeck: [], energyDeck: [] },
  });
  vi.mocked(runAiSelfPlay).mockResolvedValue(REPORT);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  await Promise.all(TEMP_DIRS.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('interactive CLI arguments and bounded input', () => {
  it('uses development wait limits and a single controlled seat', () => {
    expect(parseAiInteractiveCliArgs(['--deck=a', '--output=b'])).toMatchObject({
      deckPath: resolve('a'),
      opponentDeckPath: resolve('a'),
      outputPath: resolve('b'),
      seat: 'FIRST',
      decisionTimeoutMs: 300_000,
      maxWallTimeMs: 3_600_000,
    });
    expect(
      parseAiInteractiveCliArgs([
        '--deck=a',
        '--output=b',
        '--seat=SECOND',
        '--seed=0',
        '--opponent-deck=c',
        '--trace-output=d',
        '--max-steps=3',
        '--max-turns=2',
        '--decision-timeout-ms=42',
        '--max-wall-time-ms=90',
      ])
    ).toMatchObject({
      seat: 'SECOND',
      seed: 0,
      maxSteps: 3,
      maxTurns: 2,
      decisionTimeoutMs: 42,
      maxWallTimeMs: 90,
      traceOutputPath: resolve('d'),
      opponentDeckPath: resolve('c'),
    });
  });
  it.each([
    [],
    ['--deck=a'],
    ['--output=b'],
    ['--deck=a', '--output=b', '--seat=BOTH'],
    ['--deck=a', '--output=b', '--seed=-1'],
    ['--deck=a', '--output=b', '--seed=4294967296'],
    ['--deck=a', '--output=b', '--max-steps=0'],
    ['--deck=a', '--output=b', '--max-turns=1e3'],
    ['--deck=a', '--output=b', '--decision-timeout-ms=2147483648'],
    ['--deck=a', '--output=b', '--max-wall-time-ms=0'],
    ['--deck=a', '--output=b', '--trace-output='],
    ['--deck=a', '--output=b', '--seat=FIRST', '--seat=SECOND'],
    ['--deck=a', '--output=b', '--extra=x'],
  ])('rejects malformed arguments %j', (...args) => {
    expect(() => parseAiInteractiveCliArgs(args)).toThrow();
  });
  it('handles chunked UTF-8/CRLF and resumes after a discarded oversized line', () => {
    const lines: string[] = [];
    const oversized = vi.fn();
    const read = createInteractiveLineReader((line) => lines.push(line), oversized);
    const text = Buffer.from('"花帆"\r\n');
    read(text.subarray(0, 2));
    read(text.subarray(2));
    read(Buffer.alloc(MAX_INTERACTIVE_INPUT_LINE_BYTES, 120));
    read('more-secret');
    read(Buffer.alloc(MAX_INTERACTIVE_INPUT_LINE_BYTES, 121));
    expect(oversized).toHaveBeenCalledTimes(1);
    read('\n{}\n');
    expect(lines).toEqual(['"花帆"', '{}']);
  });
  it('accepts exactly the byte limit and does not interpret an unfinished line', () => {
    const lines: string[] = [];
    const read = createInteractiveLineReader(
      (line) => lines.push(line),
      () => {
        throw Error('oversized');
      }
    );
    read('x'.repeat(MAX_INTERACTIVE_INPUT_LINE_BYTES));
    expect(lines).toEqual([]);
    read('\n{"type":"stop"}');
    expect(lines).toEqual(['x'.repeat(MAX_INTERACTIVE_INPUT_LINE_BYTES)]);
  });
});

describe('interactive local transport', () => {
  it.each(['FIRST', 'SECOND'] as const)(
    'controls only %s and leaves the peer on its fixed provider',
    async (seat) => {
      const dir = await directory();
      const transport = io((message, input) => {
        if (message.type === 'decision') input.write(`${JSON.stringify(answer(request(seat)))}\n`);
      });
      vi.mocked(runAiSelfPlay).mockImplementation(async (options) => {
        const peer = seat === 'FIRST' ? 'SECOND' : 'FIRST';
        expect(options.providers?.[seat]).toBeInstanceOf(LocalInteractiveAiProvider);
        expect(options.providers?.[peer]).not.toBeInstanceOf(LocalInteractiveAiProvider);
        await options.providers![peer].decide(request(peer), options.signal!);
        expect(await options.providers![seat].decide(request(seat), options.signal!)).toEqual(
          answer(request(seat))
        );
        return REPORT;
      });
      const originalConsole = globalThis.console;
      await runAiInteractiveCli(
        [
          '--deck=mine',
          '--opponent-deck=theirs',
          `--seat=${seat}`,
          `--output=${join(dir, 'report.json')}`,
          '--seed=0',
          '--max-steps=5',
          '--max-turns=3',
        ],
        transport
      );
      expect(globalThis.console).toBe(originalConsole);
      expect(loadLocalSelfPlayDecks).toHaveBeenCalledWith(
        resolve(seat === 'FIRST' ? 'mine' : 'theirs'),
        resolve(seat === 'FIRST' ? 'theirs' : 'mine'),
        expect.any(String)
      );
      const decisions = transport.messages.filter((message) => message.type === 'decision');
      expect(decisions).toHaveLength(1);
      expect(JSON.stringify(decisions)).toContain(`VISIBLE_${seat}`);
      expect(JSON.stringify(decisions)).not.toContain(
        `VISIBLE_${seat === 'FIRST' ? 'SECOND' : 'FIRST'}`
      );
      expect(transport.messages).toContainEqual({ type: 'input_status', status: 'FORWARDED' });
      expect(transport.messages.at(-1)).toMatchObject({
        type: 'finished',
        summary: { status: 'LIMIT_REACHED', stepCount: 0 },
      });
      expect(transport.messages.at(-1)?.summary).not.toHaveProperty('steps');
      expect(vi.mocked(runAiSelfPlay).mock.calls[0]![0]).toMatchObject({
        maxSteps: 5,
        maxTurns: 3,
        decisionTimeoutMs: 300_000,
        maxWallTimeMs: 3_600_000,
      });
      expect((await stat(join(dir, 'report.json'))).mode & 0o777).toBe(0o600);
      expect(transport.input.listenerCount('data')).toBe(0);
      expect(transport.signals.listenerCount('SIGINT')).toBe(0);
    }
  );
  it('reports parse, envelope, stale and oversize failures without consuming or echoing the request', async () => {
    const dir = await directory();
    const transport = io((message, input) => {
      if (message.type !== 'decision') return;
      input.write('private-invalid-json\nnull\n');
      input.write(`${JSON.stringify({ ...answer(), decisionId: 'old-private-id' })}\n`);
      input.write(`${'secret'.repeat(MAX_INTERACTIVE_INPUT_LINE_BYTES)}\n`);
      input.write(`${JSON.stringify(answer())}\n${JSON.stringify(answer())}\n`);
    });
    vi.mocked(runAiSelfPlay).mockImplementation(async (options) => {
      expect(await options.providers!.FIRST.decide(request(), options.signal!)).toEqual(answer());
      return REPORT;
    });
    await runAiInteractiveCli(['--deck=a', `--output=${join(dir, 'r.json')}`], transport);
    expect(
      transport.messages
        .filter((message) => message.type === 'input_status')
        .map((message) => message.status)
    ).toEqual([
      'INVALID_JSON',
      'INVALID_ENVELOPE',
      'STALE_DECISION',
      'LINE_TOO_LARGE',
      'FORWARDED',
      'NO_PENDING_DECISION',
    ]);
    expect(JSON.stringify(transport.messages)).not.toMatch(
      /private-invalid-json|old-private-id|secret/
    );
  });
  it('reports the actual step outcome separately from forwarding, without repeating steps at finish', async () => {
    const dir = await directory();
    const transport = io((message, input) => {
      if (message.type === 'decision') input.write(`${JSON.stringify(answer())}\n`);
    });
    const progress = {
      turnCount: 0,
      phase: GamePhase.MULLIGAN_PHASE,
      subPhase: SubPhase.MULLIGAN_FIRST_PLAYER,
      successCounts: { FIRST: 0, SECOND: 0 },
      winnerSeat: null,
      endReason: null,
    };
    const step = {
      index: 1,
      actor: 'FIRST' as const,
      kind: 'MULLIGAN' as const,
      status: 'REJECTED' as const,
      commandType: null,
      before: progress,
      after: progress,
      durationMs: 2,
      providerMs: 1,
      virtualWaitMs: 0,
    };
    vi.mocked(runAiSelfPlay).mockImplementation(async (options) => {
      await options.providers!.FIRST.decide(request(), options.signal!);
      options.onStep?.(step);
      return { ...REPORT, steps: [step] };
    });
    await runAiInteractiveCli(['--deck=a', `--output=${join(dir, 'r.json')}`], transport);
    expect(transport.messages.map((message) => message.type)).toEqual([
      'decision',
      'input_status',
      'step',
      'finished',
    ]);
    expect(transport.messages[1]).toEqual({ type: 'input_status', status: 'FORWARDED' });
    expect(transport.messages[2]).toEqual({ type: 'step', step });
    expect(transport.messages[3]?.summary).toMatchObject({ stepCount: 1 });
    expect(transport.messages[3]?.summary).not.toHaveProperty('steps');
    expect(JSON.parse(await readFile(join(dir, 'r.json'), 'utf8'))).toMatchObject({
      steps: [step],
    });
  });
  it.each(['stop', 'eof', 'sigint', 'input_error'] as const)(
    'cancels on %s and releases a pending wait',
    async (how) => {
      const dir = await directory();
      const transport = io((message, input) => {
        if (message.type !== 'decision') return;
        if (how === 'stop') input.write('{"type":"stop"}\n');
        else if (how === 'eof') input.end('{"schemaVersion":2');
        else if (how === 'sigint') transport.signals.emit('SIGINT');
        else input.emit('error', new Error('private-input-error'));
      });
      vi.mocked(runAiSelfPlay).mockImplementation(async (options) => {
        expect(await options.providers!.FIRST.decide(request(), options.signal!)).toBeNull();
        expect(options.signal!.aborted).toBe(true);
        return { ...REPORT, status: 'ABORTED', stopReason: 'ABORTED' };
      });
      const run = runAiInteractiveCli(['--deck=a', `--output=${join(dir, 'r.json')}`], transport);
      if (how === 'input_error') await expect(run).rejects.toThrow('files were retained');
      else await run;
      expect(JSON.stringify(transport.messages)).not.toContain('private-input-error');
      expect(JSON.parse(await readFile(join(dir, 'r.json'), 'utf8'))).toMatchObject({
        status: 'ABORTED',
      });
    }
  );
  it('passes an already-ended input as aborted instead of waiting for a new decision', async () => {
    const dir = await directory();
    const transport = io();
    transport.input.resume();
    transport.input.end();
    await new Promise<void>((done) => transport.input.on('end', done));
    vi.mocked(runAiSelfPlay).mockImplementation((options) => {
      expect(options.signal!.aborted).toBe(true);
      return Promise.resolve({ ...REPORT, status: 'ABORTED', stopReason: 'ABORTED' });
    });
    await runAiInteractiveCli(['--deck=a', `--output=${join(dir, 'r.json')}`], transport);
  });
  it('writes only the selected seat private trace and keeps the report anonymous', async () => {
    const dir = await directory();
    const exported = vi.spyOn(AiDecisionTraceRecorder.prototype, 'getSeatTrace');
    vi.mocked(runAiSelfPlay).mockImplementation((options) => {
      for (const seat of ['FIRST', 'SECOND'] as const) {
        options
          .traceRecorder!.begin(request(seat))
          .finish({ status: 'NO_DECISION', decisionId: 'd1' });
      }
      return Promise.resolve(REPORT);
    });
    await runAiInteractiveCli(
      [
        '--deck=a',
        '--seat=SECOND',
        `--output=${join(dir, 'r.json')}`,
        `--trace-output=${join(dir, 'private.json')}`,
      ],
      io()
    );
    expect(exported).toHaveBeenCalledExactlyOnceWith('SECOND');
    const trace = await readFile(join(dir, 'private.json'), 'utf8');
    expect(trace).toContain('VISIBLE_SECOND');
    expect(trace).not.toContain('VISIBLE_FIRST');
    expect(await readFile(join(dir, 'r.json'), 'utf8')).not.toContain('VISIBLE_');
    expect((await stat(join(dir, 'private.json'))).mode & 0o777).toBe(0o600);
  });
  it('retains exclusively reserved files and emits no raw error when the runner throws', async () => {
    const dir = await directory();
    vi.mocked(runAiSelfPlay).mockRejectedValue(new Error('opponent-secret'));
    const transport = io();
    await expect(
      runAiInteractiveCli(
        ['--deck=a', `--output=${join(dir, 'r.json')}`, `--trace-output=${join(dir, 'p.json')}`],
        transport
      )
    ).rejects.toThrow('files were retained');
    expect(await readdir(dir)).toEqual(['p.json', 'r.json']);
    expect(await readFile(join(dir, 'r.json'), 'utf8')).toBe('');
    expect(JSON.stringify(transport.messages)).not.toContain('opponent-secret');
    expect(transport.input.listenerCount('data')).toBe(0);
  });
  it('stops after a broken output without exposing its error', async () => {
    const dir = await directory();
    const transport = io();
    transport.output = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('hidden-error'));
      },
    });
    vi.mocked(runAiSelfPlay).mockImplementation(async (options) => {
      expect(await options.providers!.FIRST.decide(request(), options.signal!)).toBeNull();
      return { ...REPORT, status: 'ABORTED', stopReason: 'ABORTED' };
    });
    await expect(
      runAiInteractiveCli(['--deck=a', `--output=${join(dir, 'r.json')}`], transport)
    ).rejects.toThrow('files were retained');
    expect(await readFile(join(dir, 'r.json'), 'utf8')).not.toContain('hidden-error');
  });
  it('cancels a pending decision when output closes without an error or write callback', async () => {
    const dir = await directory();
    const transport = io();
    transport.output = new Writable({
      write() {
        globalThis.queueMicrotask(() => transport.output.destroy());
      },
    });
    vi.mocked(runAiSelfPlay).mockImplementation(async (options) => {
      expect(await options.providers!.FIRST.decide(request(), options.signal!)).toBeNull();
      expect(options.signal!.aborted).toBe(true);
      return { ...REPORT, status: 'ABORTED', stopReason: 'ABORTED' };
    });
    await expect(
      runAiInteractiveCli(['--deck=a', `--output=${join(dir, 'r.json')}`], transport)
    ).rejects.toThrow('files were retained');
    expect(JSON.parse(await readFile(join(dir, 'r.json'), 'utf8'))).toMatchObject({
      status: 'ABORTED',
    });
    expect(transport.output.listenerCount('close')).toBe(0);
    expect(transport.input.listenerCount('data')).toBe(0);
  });
  it.each(['sigint', 'stop', 'output_close'] as const)(
    'releases a stalled finished write on %s while retaining the completed report and private trace',
    async (how) => {
      const dir = await directory();
      const transport = io();
      transport.output = new Writable({
        highWaterMark: 1,
        write(chunk, _encoding, callback) {
          const message = JSON.parse(String(chunk)) as { type: string };
          if (message.type !== 'finished') {
            callback();
            return;
          }
          globalThis.setImmediate(() => {
            if (how === 'sigint') transport.signals.emit('SIGINT');
            else if (how === 'stop') transport.input.write('{"type":"stop"}\n');
            else transport.output.destroy();
          });
          // A blocked pipe can keep this write callback pending indefinitely.
        },
      });
      vi.mocked(runAiSelfPlay).mockImplementation((options) => {
        options.traceRecorder!.begin(request()).finish({ status: 'NO_DECISION', decisionId: 'd1' });
        return Promise.resolve({ ...REPORT, status: 'COMPLETED', stopReason: 'GAME_END' });
      });
      await expect(
        runAiInteractiveCli(
          ['--deck=a', `--output=${join(dir, 'r.json')}`, `--trace-output=${join(dir, 'p.json')}`],
          transport
        )
      ).rejects.toThrow('files were retained');
      expect(JSON.parse(await readFile(join(dir, 'r.json'), 'utf8'))).toMatchObject({
        status: 'COMPLETED',
        stopReason: 'GAME_END',
      });
      expect(await readFile(join(dir, 'p.json'), 'utf8')).toContain('VISIBLE_FIRST');
      expect(runAiSelfPlay).toHaveBeenCalledTimes(1);
      expect(transport.output.destroyed).toBe(true);
      expect(transport.output.listenerCount('close')).toBe(0);
      expect(transport.input.listenerCount('data')).toBe(0);
      expect(transport.signals.listenerCount('SIGINT')).toBe(0);
    }
  );
  it.each(['late_answer', 'invalid_json', 'oversize'] as const)(
    'keeps accepting stop in a later chunk after %s during a stalled finished write',
    async (how) => {
      const dir = await directory();
      const transport = io();
      transport.output = new Writable({
        highWaterMark: 1,
        write(chunk, _encoding, callback) {
          const message = JSON.parse(String(chunk)) as { type: string };
          if (message.type !== 'finished') {
            callback();
            return;
          }
          globalThis.setImmediate(() => {
            const lateInput =
              how === 'late_answer'
                ? JSON.stringify(answer())
                : how === 'invalid_json'
                  ? '{invalid'
                  : 'x'.repeat(MAX_INTERACTIVE_INPUT_LINE_BYTES + 1);
            transport.input.write(`${lateInput}\n`);
            globalThis.setImmediate(() => transport.input.write('{"type":"stop"}\n'));
          });
        },
      });
      await expect(
        runAiInteractiveCli(['--deck=a', `--output=${join(dir, 'r.json')}`], transport)
      ).rejects.toThrow('files were retained');
      expect(JSON.parse(await readFile(join(dir, 'r.json'), 'utf8'))).toMatchObject(REPORT);
      expect(runAiSelfPlay).toHaveBeenCalledTimes(1);
      expect(transport.output.destroyed).toBe(true);
      expect(transport.input.listenerCount('data')).toBe(0);
    }
  );
});

describe('interactive file safety and executable', () => {
  it('refuses existing report, private output and dangling symlinks before running', async () => {
    const dir = await directory();
    const existing = join(dir, 'keep.json');
    await writeFile(existing, 'keep');
    for (const args of [
      [`--output=${existing}`],
      [`--output=${join(dir, 'fresh.json')}`, `--trace-output=${existing}`],
    ])
      await expect(runAiInteractiveCli(['--deck=a', ...args], io())).rejects.toThrow('overwrite');
    const link = join(dir, 'dangling');
    await symlink(join(dir, 'missing'), link);
    await expect(runAiInteractiveCli(['--deck=a', `--output=${link}`], io())).rejects.toThrow(
      'overwrite'
    );
    expect(await readFile(existing, 'utf8')).toBe('keep');
    expect(loadLocalSelfPlayDecks).not.toHaveBeenCalled();
    expect(runAiSelfPlay).not.toHaveBeenCalled();
  });
  it('rejects missing parents and equivalent trace/report paths without creating output', async () => {
    const dir = await directory();
    await expect(
      runAiInteractiveCli(['--deck=a', `--output=${join(dir, 'missing/r.json')}`], io())
    ).rejects.toThrow();
    const alias = join(dir, 'alias');
    await symlink(dir, alias);
    await expect(
      runAiInteractiveCli(
        ['--deck=a', `--output=${join(dir, 'r.json')}`, `--trace-output=${join(alias, 'r.json')}`],
        io()
      )
    ).rejects.toThrow('separate');
    expect(await readdir(dir)).toEqual(['alias']);
    expect(runAiSelfPlay).not.toHaveBeenCalled();
  });
  it('reserves both files before exposing any decision', async () => {
    const dir = await directory();
    const reportPath = join(dir, 'r.json');
    const tracePath = join(dir, 't.json');
    vi.mocked(runAiSelfPlay).mockImplementation(async () => {
      expect(await readFile(reportPath, 'utf8')).toBe('');
      expect(await readFile(tracePath, 'utf8')).toBe('');
      await expect(writeFile(reportPath, 'overwrite', { flag: 'wx' })).rejects.toMatchObject({
        code: 'EEXIST',
      });
      return REPORT;
    });
    await runAiInteractiveCli(
      ['--deck=a', `--output=${reportPath}`, `--trace-output=${tracePath}`],
      io()
    );
  });
  it('runs the real entry with only JSONL output and cancels through its public input', async () => {
    const dir = await directory();
    const script = fileURLToPath(new URL('../../scripts/run-ai-interactive.ts', import.meta.url));
    const deck = fileURLToPath(new URL('../../assets/decks/绿莲-6弹ver.yaml', import.meta.url));
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        script,
        `--deck=${deck}`,
        `--output=${join(dir, 'r.json')}`,
        '--seed=2',
        '--max-wall-time-ms=5000',
      ],
      { stdio: 'pipe' }
    );
    let stdout = '',
      stderr = '';
    let stopping = false;
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (!stopping && stdout.includes('\n')) {
        stopping = true;
        child.stdin.end('{"type":"stop"}\n');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const code = await new Promise<number | null>((done, reject) => {
      child.on('error', reject);
      child.on('exit', done);
    });
    expect(code).toBe(0);
    expect(stderr).toBe('');
    const messages = stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string });
    expect(messages[0]?.type).toBe('decision');
    expect(messages.at(-1)?.type).toBe('finished');
    expect(JSON.parse(await readFile(join(dir, 'r.json'), 'utf8'))).toMatchObject({
      status: 'ABORTED',
    });
  }, 15_000);
});
