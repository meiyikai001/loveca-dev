import { describe, expect, it, vi } from 'vitest';
import type {
  AiDecisionRequestV2,
  AiDecisionV2,
} from '../../src/application/ai/ai-decision-contract.js';
import { LocalInteractiveAiProvider } from '../../src/server/services/local-interactive-ai-provider.js';
import { CardType } from '../../src/shared/types/enums.js';

function request(id = 'decision-1'): AiDecisionRequestV2 {
  return {
    schemaVersion: 2,
    decisionId: id,
    contextDigest: `digest-${id}`,
    observation: {
      match: {
        viewerSeat: 'FIRST',
        turnCount: 0,
        phase: 'MULLIGAN',
        subPhase: 'MULLIGAN',
        firstSeat: 'FIRST',
        activeSeat: null,
        prioritySeat: 'FIRST',
        publicSequence: 0,
        window: null,
      },
      zoneCounts: [],
    },
    window: {
      kind: 'MULLIGAN',
      minSelections: 0,
      maxSelections: 1,
      candidates: [{ token: 'card-1', card: { cardCode: 'VISIBLE', cardType: CardType.MEMBER } }],
    },
  };
}

function keep(input: AiDecisionRequestV2): AiDecisionV2 {
  return {
    schemaVersion: 2,
    decisionId: input.decisionId,
    contextDigest: input.contextDigest,
    kind: 'MULLIGAN',
    selectedCardTokens: [],
  };
}

describe('LocalInteractiveAiProvider', () => {
  it('waits for a response and forwards a detached copy without changing the original request', async () => {
    let observed: AiDecisionRequestV2 | undefined;
    const provider = new LocalInteractiveAiProvider({
      seat: 'FIRST',
      onRequest: (value) => {
        observed = value;
      },
    });
    const input = request();
    const pending = provider.decide(input, new AbortController().signal);
    expect(observed).toEqual(input);
    expect(observed).not.toBe(input);
    if (observed?.window.kind === 'MULLIGAN') {
      (observed.window.candidates[0]!.card as { cardCode: string }).cardCode = 'changed';
    }
    expect(input.window.candidates[0]).toMatchObject({ card: { cardCode: 'VISIBLE' } });
    const answer = keep(input);
    expect(provider.submit(answer).status).toBe('FORWARDED');
    (answer as { decisionId: string }).decisionId = 'changed';
    expect(await pending).toEqual(keep(input));
    expect(provider.submit(keep(input)).status).toBe('NO_PENDING_DECISION');
  });

  it('does not buffer answers submitted before a decision or accept a stale answer for the next one', async () => {
    const provider = new LocalInteractiveAiProvider({ seat: 'FIRST', onRequest: () => {} });
    expect(provider.submit(keep(request())).status).toBe('NO_PENDING_DECISION');
    const first = provider.decide(request(), new AbortController().signal);
    expect(provider.submit(keep(request())).status).toBe('FORWARDED');
    await first;
    const secondInput = request('decision-2');
    const second = provider.decide(secondInput, new AbortController().signal);
    expect(provider.submit(keep(request())).status).toBe('STALE_DECISION');
    expect(provider.submit(keep(secondInput)).status).toBe('FORWARDED');
    expect(await second).toEqual(keep(secondInput));
  });

  it('rejects malformed and mismatched envelopes without consuming the pending decision', async () => {
    const provider = new LocalInteractiveAiProvider({ seat: 'FIRST', onRequest: () => {} });
    const input = request();
    const pending = provider.decide(input, new AbortController().signal);
    for (const invalid of [
      null,
      [],
      1,
      'secret',
      {},
      { ...keep(input), schemaVersion: 1 },
      { ...keep(input), contextDigest: '' },
      () => {},
    ]) {
      expect(provider.submit(invalid).status).toBe('INVALID_ENVELOPE');
    }
    expect(provider.submit({ ...keep(input), contextDigest: 'old' }).status).toBe('STALE_DECISION');
    expect(provider.submit({ ...keep(input), kind: 'MAIN_ACTION' }).status).toBe('STALE_DECISION');
    provider.submit(keep(input));
    await expect(pending).resolves.toEqual(keep(input));
  });

  it('leaves token and extra-field validation to the existing authoritative resolver', async () => {
    const provider = new LocalInteractiveAiProvider({ seat: 'FIRST', onRequest: () => {} });
    const input = request();
    const pending = provider.decide(input, new AbortController().signal);
    const invalidAction = {
      ...keep(input),
      selectedCardTokens: ['invented-token'],
      forbidden: 'extra',
    };
    expect(provider.submit(invalidAction).status).toBe('FORWARDED');
    expect(await pending).toEqual(invalidAction);
  });

  it('rejects another seat and concurrent requests without exposing or replacing the pending request', async () => {
    const onRequest = vi.fn();
    const provider = new LocalInteractiveAiProvider({ seat: 'FIRST', onRequest });
    const input = request();
    const wrongSeat = globalThis.structuredClone(input);
    (wrongSeat.observation.match as { viewerSeat: string }).viewerSeat = 'SECOND';
    await expect(provider.decide(wrongSeat, new AbortController().signal)).rejects.toThrow(
      'seat mismatch'
    );
    expect(onRequest).not.toHaveBeenCalled();
    const pending = provider.decide(input, new AbortController().signal);
    await expect(provider.decide(request('next'), new AbortController().signal)).rejects.toThrow(
      'already pending'
    );
    expect(onRequest).toHaveBeenCalledTimes(1);
    provider.submit(keep(input));
    expect(await pending).toEqual(keep(input));
  });

  it('clears an aborted wait, rejects late answers and supports a subsequent request', async () => {
    const provider = new LocalInteractiveAiProvider({ seat: 'FIRST', onRequest: () => {} });
    const abort = new AbortController();
    const pending = provider.decide(request(), abort.signal);
    abort.abort();
    expect(await pending).toBeNull();
    expect(provider.submit(keep(request())).status).toBe('NO_PENDING_DECISION');
    expect(await provider.decide(request(), abort.signal)).toBeNull();
    const next = request('next');
    const resumed = provider.decide(next, new AbortController().signal);
    provider.submit(keep(next));
    expect(await resumed).toEqual(keep(next));
  });

  it('closes idempotently and settles a pending wait without a fallback action', async () => {
    const onRequest = vi.fn();
    const provider = new LocalInteractiveAiProvider({ seat: 'FIRST', onRequest });
    const pending = provider.decide(request(), new AbortController().signal);
    provider.close();
    provider.close();
    expect(await pending).toBeNull();
    expect(provider.submit(keep(request())).status).toBe('CLOSED');
    expect(await provider.decide(request('next'), new AbortController().signal)).toBeNull();
    expect(onRequest).toHaveBeenCalledTimes(1);
  });

  it('permits a synchronous local response and handles delivery failures without leaking error text', async () => {
    const provider = new LocalInteractiveAiProvider({
      seat: 'FIRST',
      onRequest: (value) => {
        provider.submit(keep(value));
      },
    });
    expect(await provider.decide(request(), new AbortController().signal)).toEqual(keep(request()));
    const failed = new LocalInteractiveAiProvider({
      seat: 'FIRST',
      onRequest: () => {
        throw new Error('private-stack-and-ids');
      },
    });
    await expect(failed.decide(request(), new AbortController().signal)).rejects.toThrow(
      'Interactive request delivery failed'
    );
    expect(failed.submit(keep(request())).status).toBe('NO_PENDING_DECISION');
  });
});
