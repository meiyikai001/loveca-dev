import { describe, expect, it } from 'vitest';
import type {
  AiDecisionRequestV2,
  AiDecisionV2,
  AiLiveActionObservationV2,
} from '../../src/application/ai/ai-decision-contract';
import {
  resolveAiDecisionV2,
  type AiDecisionFrameV2,
  type TrustedMainActionCandidateV2,
} from '../../src/application/ai/ai-decision-frame';
import { GameCommandType } from '../../src/application/game-commands';
import type { Seat } from '../../src/online/types';
import { CardType, SlotPosition } from '../../src/shared/types/enums';
import { AiDecisionTraceRecorder } from '../../src/server/services/ai-decision-trace-recorder';
import type { AiTurnStepResult } from '../../src/server/services/ai-turn-coordinator';

function requestBase(seat: Seat = 'FIRST') {
  const energy = {
    activeCount: 0,
    totalCount: 0,
    skipsNextActivePhase: { activeCount: 0, waitingCount: 0 },
  };
  const observation: AiLiveActionObservationV2 = {
    match: {
      viewerSeat: seat,
      turnCount: 1,
      phase: 'MAIN_PHASE',
      subPhase: 'NONE',
      firstSeat: 'FIRST',
      activeSeat: seat,
      prioritySeat: seat,
      publicSequence: 0,
      window: null,
    },
    zoneCounts: [],
    self: { hand: [], stage: [], energy },
    opponent: { seat: seat === 'FIRST' ? 'SECOND' : 'FIRST', stage: [], energy },
    visibleZones: [],
    live: { players: [], winnerSeats: [], confirmedSeats: [] },
  };
  return {
    schemaVersion: 2 as const,
    decisionId: `decision-${seat}`,
    contextDigest: 'context-digest',
    observation,
  };
}

function frame(request: AiDecisionRequestV2): AiDecisionFrameV2 {
  return {
    request,
    canonicalContext: 'NOT-FOR-TRACE',
    mulliganCardIdByToken: new Map(),
    mainActionByToken: new Map(),
    effectActionByToken: new Map(),
    liveActionByToken: new Map(),
    effectCardSelection: null,
    effectCardIdByToken: new Map(),
  };
}

function mulliganFrame(seat: Seat = 'FIRST'): AiDecisionFrameV2 {
  return {
    ...frame({
      ...requestBase(seat),
      window: {
        kind: 'MULLIGAN',
        minSelections: 0,
        maxSelections: 2,
        candidates: ['hand-1', 'hand-2'].map((token) => ({
          token,
          card: { cardCode: `${seat}-${token}`, cardType: CardType.MEMBER },
        })),
      },
    }),
    mulliganCardIdByToken: new Map([
      ['hand-1', 'INTERNAL-FIRST-CARD'],
      ['hand-2', 'INTERNAL-SECOND-CARD'],
    ]),
  };
}

function recordChoice(
  target: AiDecisionFrameV2,
  choice: AiDecisionV2,
  recorder = new AiDecisionTraceRecorder()
) {
  const handle = recorder.begin(target.request);
  const resolution = resolveAiDecisionV2(target, choice);
  if (!resolution.ok) throw new Error(resolution.reason);
  handle.setChoice(target, resolution);
  handle.finish({
    status: 'EXECUTED',
    decisionId: target.request.decisionId,
    commandType: resolution.commandType,
    resultingPublicSequence: 1,
  });
  const trace = recorder.getSeatTrace(target.request.observation.match.viewerSeat);
  expect(trace.incomplete).toBe(false);
  expect(trace.records[0]?.validatedChoice).toEqual(choice);
  expect(JSON.stringify(trace)).not.toContain('INTERNAL-');
  expect(JSON.stringify(trace)).not.toContain('NOT-FOR-TRACE');
  return trace;
}

function decisionBase(target: AiDecisionFrameV2) {
  return {
    schemaVersion: 2 as const,
    decisionId: target.request.decisionId,
    contextDigest: target.request.contextDigest,
  };
}

describe('AiDecisionTraceRecorder', () => {
  it('snapshots before provider mutation, keeps seats separate and exports detached data', () => {
    const recorder = new AiDecisionTraceRecorder();
    const first = mulliganFrame();
    const second = mulliganFrame('SECOND');
    const pristine = globalThis.structuredClone(first.request);
    const handle = recorder.begin(first.request);
    Object.assign(first.request, { decisionId: 'provider-mutated' });
    Object.assign(first.request.observation.match, { viewerSeat: 'SECOND' });
    handle.finish({ status: 'NO_DECISION', decisionId: 'provider-mutated' });
    recorder.begin(second.request).finish({ status: 'TIMEOUT', decisionId: 'second' });
    const firstTrace = recorder.getSeatTrace('FIRST');
    expect(firstTrace.records[0]?.request).toEqual(pristine);
    expect(firstTrace.records).toHaveLength(1);
    expect(JSON.stringify(firstTrace)).not.toContain('SECOND-hand-');
    expect(JSON.stringify(recorder.getSeatTrace('SECOND'))).not.toContain('FIRST-hand-');
    Object.assign(firstTrace.records[0]!.request, { decisionId: 'export-mutated' });
    expect(recorder.getSeatTrace('FIRST').records[0]?.request.decisionId).toBe('decision-FIRST');
  });

  it.each([['hand-2', 'hand-1'], []])('reconstructs ordered/empty mulligan %j', (...tokens) => {
    const target = mulliganFrame();
    recordChoice(target, { ...decisionBase(target), kind: 'MULLIGAN', selectedCardTokens: tokens });
  });

  it('reconstructs main choices by card, ability, slot and relay semantics', () => {
    const bindings: TrustedMainActionCandidateV2[] = [
      {
        kind: 'END_PHASE',
        binding: { type: GameCommandType.END_PHASE, playerId: 'INTERNAL-PLAYER' },
      },
      ...['INTERNAL-ABILITY-1', 'INTERNAL-ABILITY-2'].map((abilityId) => ({
        kind: 'ACTIVATE_ABILITY' as const,
        sourceSlot: SlotPosition.LEFT,
        binding: {
          type: GameCommandType.ACTIVATE_ABILITY as const,
          playerId: 'INTERNAL-PLAYER',
          cardId: 'INTERNAL-SOURCE',
          abilityId,
        },
      })),
      ...(['EMPTY', 'SINGLE_RELAY'] as const).map((playMode) => ({
        kind: 'PLAY_MEMBER_TO_SLOT' as const,
        playMode,
        binding: {
          type: GameCommandType.PLAY_MEMBER_TO_SLOT as const,
          playerId: 'INTERNAL-PLAYER',
          cardId: 'INTERNAL-HAND',
          targetSlot: SlotPosition.RIGHT,
        },
        preview: { printedCost: 1, modifiedCost: 1, energyCost: 1, relayDiscount: 0 },
      })),
    ];
    const target: AiDecisionFrameV2 = {
      ...frame({
        ...requestBase(),
        window: {
          kind: 'MAIN_ACTION',
          minSelections: 1,
          maxSelections: 1,
          candidates: bindings.map((action, index) => {
            const actionToken = `action-${index}`;
            if (action.kind === 'END_PHASE')
              return { kind: 'END_MAIN_PHASE' as const, actionToken };
            if (action.kind === 'ACTIVATE_ABILITY')
              return {
                kind: action.kind,
                actionToken,
                legality: 'DECLARATION_ONLY' as const,
                sourceSlot: action.sourceSlot,
                abilityText: 'Activate this ability',
              };
            return {
              kind:
                action.playMode === 'EMPTY'
                  ? ('PLAY_MEMBER_TO_EMPTY_SLOT' as const)
                  : ('PLAY_MEMBER_WITH_SINGLE_RELAY' as const),
              actionToken,
              sourceHandToken: 'hand-1',
              targetSlot: action.binding.targetSlot,
              payment: { modifiedCost: 1, energyCost: 1, relayDiscount: 0 },
            };
          }),
        },
      }),
      mainActionByToken: new Map(bindings.map((binding, index) => [`action-${index}`, binding])),
    };
    for (const index of bindings.keys()) {
      recordChoice(target, {
        ...decisionBase(target),
        kind: 'MAIN_ACTION',
        selectedActionToken: `action-${index}`,
      });
    }
  });

  it('uses effect binding identity and never serializes its private option', () => {
    const target: AiDecisionFrameV2 = {
      ...frame({
        ...requestBase(),
        window: {
          kind: 'EFFECT_STEP',
          minSelections: 1,
          maxSelections: 1,
          sourceCard: null,
          controllerSeat: 'FIRST',
          effectText: 'Choose an option',
          stepText: 'Choose',
          candidates: [{ kind: 'SELECT_OPTION', actionToken: 'effect-1', label: 'Option' }],
        },
      }),
      effectActionByToken: new Map([
        [
          'effect-1',
          {
            kind: 'SELECT_OPTION',
            binding: {
              type: GameCommandType.CONFIRM_EFFECT_STEP,
              playerId: 'INTERNAL-PLAYER',
              effectId: 'INTERNAL-EFFECT',
              selectedOptionId: 'INTERNAL-OPTION',
            },
          },
        ],
      ]),
    };
    recordChoice(target, {
      ...decisionBase(target),
      kind: 'EFFECT_STEP',
      selectedActionToken: 'effect-1',
    });
  });

  it('uses live binding identity without retaining the judgment map', () => {
    const target: AiDecisionFrameV2 = {
      ...frame({
        ...requestBase(),
        window: {
          kind: 'LIVE_ACTION',
          minSelections: 1,
          maxSelections: 1,
          candidates: [{ kind: 'SUBMIT_JUDGMENT', actionToken: 'live-1' }],
        },
      }),
      liveActionByToken: new Map([
        [
          'live-1',
          {
            kind: 'SUBMIT_JUDGMENT',
            binding: {
              type: GameCommandType.SUBMIT_JUDGMENT,
              playerId: 'INTERNAL-PLAYER',
              judgmentResults: new Map(),
            },
          },
        ],
      ]),
    };
    const trace = recordChoice(target, {
      ...decisionBase(target),
      kind: 'LIVE_ACTION',
      selectedActionToken: 'live-1',
    });
    expect(JSON.stringify(trace)).not.toContain('judgmentResults');
  });

  it('preserves multi-selection order, explicit empty selection and distinct skip', () => {
    const target: AiDecisionFrameV2 = {
      ...frame({
        ...requestBase(),
        window: {
          kind: 'EFFECT_CARD_SELECTION',
          legality: 'DECLARATION_ONLY',
          minSelections: 0,
          maxSelections: 2,
          ordered: true,
          canSkip: true,
          sourceCard: null,
          controllerSeat: 'FIRST',
          effectText: 'Select cards',
          stepText: 'Choose',
          candidates: ['card-1', 'card-2'].map((cardToken) => ({
            cardToken,
            card: { cardCode: 'VISIBLE-CARD', cardType: CardType.MEMBER },
            ownerSeat: 'FIRST',
          })),
          distinctGroupAssignment: false,
          rejectedSelections: [],
        },
      }),
      effectCardSelection: {
        binding: {
          type: GameCommandType.CONFIRM_EFFECT_STEP,
          playerId: 'INTERNAL-PLAYER',
          effectId: 'INTERNAL-EFFECT',
        },
        cardIds: ['INTERNAL-1', 'INTERNAL-2'],
        minSelections: 0,
        maxSelections: 2,
        canSkip: true,
        distinctGroupAssignment: false,
      },
      effectCardIdByToken: new Map([
        ['card-1', 'INTERNAL-1'],
        ['card-2', 'INTERNAL-2'],
      ]),
    };
    for (const selectedCardTokens of [['card-2', 'card-1'], []]) {
      recordChoice(target, {
        ...decisionBase(target),
        kind: 'EFFECT_CARD_SELECTION',
        choice: 'SELECT',
        selectedCardTokens,
      });
    }
    recordChoice(target, {
      ...decisionBase(target),
      kind: 'EFFECT_CARD_SELECTION',
      choice: 'SKIP',
    });
  });

  it('whitelists terminal outcomes and finishes only once, ignoring all late writes', () => {
    const recorder = new AiDecisionTraceRecorder();
    const target = mulliganFrame();
    const handle = recorder.begin(target.request);
    handle.finish({
      status: 'PROVIDER_ERROR',
      decisionId: 'INTERNAL-DECISION',
      reason: 'SECRET-ERROR',
    });
    const resolution = resolveAiDecisionV2(target, {
      ...decisionBase(target),
      kind: 'MULLIGAN',
      selectedCardTokens: ['hand-1'],
    });
    if (!resolution.ok) throw new Error(resolution.reason);
    handle.setChoice(target, resolution);
    handle.finish({ status: 'ERROR' });
    const trace = recorder.getSeatTrace('FIRST');
    expect(trace.records).toHaveLength(1);
    expect(trace.records[0]?.outcome).toEqual({ status: 'PROVIDER_ERROR' });
    expect(trace.records[0]?.validatedChoice).toBeNull();
    expect(JSON.stringify(trace)).not.toContain('SECRET');
    expect(JSON.stringify(trace)).not.toContain('INTERNAL');
  });

  it('reports pending captures and omissions without throwing or exceeding its shared budget', () => {
    const target = mulliganFrame();
    const result: AiTurnStepResult = {
      status: 'NO_DECISION',
      decisionId: target.request.decisionId,
    };
    const roomy = new AiDecisionTraceRecorder();
    const pending = roomy.begin(target.request);
    expect(roomy.getSeatTrace('FIRST')).toMatchObject({ incomplete: true, pendingRecords: 1 });
    pending.finish(result);
    const bytes = Buffer.byteLength(JSON.stringify(roomy.getSeatTrace('FIRST').records[0]), 'utf8');
    const limited = new AiDecisionTraceRecorder({ maxBytes: bytes });
    limited.begin(target.request).finish(result);
    limited.begin(mulliganFrame('SECOND').request).finish(result);
    expect(limited.incomplete).toBe(true);
    expect(limited.getSeatTrace('FIRST').records).toHaveLength(1);
    expect(limited.getSeatTrace('SECOND')).toMatchObject({
      records: [],
      omittedRecords: 1,
      pendingRecords: 0,
    });
    const finishOverflow = new AiDecisionTraceRecorder({ maxBytes: bytes - 1 });
    const overflow = finishOverflow.begin(target.request);
    expect(() => overflow.finish(result)).not.toThrow();
    overflow.finish(result);
    expect(finishOverflow.getSeatTrace('FIRST')).toMatchObject({
      records: [],
      omittedRecords: 1,
      pendingRecords: 0,
    });
  });

  it('marks clone or trusted reverse-mapping failures incomplete without changing execution', () => {
    const recorder = new AiDecisionTraceRecorder();
    const target = mulliganFrame();
    Object.assign(target.request, { uncloneable: () => 'not a protocol field' });
    expect(() => recorder.begin(target.request).finish({ status: 'ERROR' })).not.toThrow();
    expect(recorder.getSeatTrace('FIRST')).toMatchObject({
      records: [],
      incomplete: true,
      omittedRecords: 1,
    });
    const mismatch = new AiDecisionTraceRecorder();
    const pristine = mulliganFrame();
    const handle = mismatch.begin(pristine.request);
    handle.setChoice(pristine, {
      ok: true,
      commandType: GameCommandType.MULLIGAN,
      cardIdsToMulligan: ['INTERNAL-MISSING'],
    });
    handle.finish({ status: 'ERROR' });
    expect(mismatch.getSeatTrace('FIRST')).toMatchObject({
      records: [],
      incomplete: true,
      omittedRecords: 1,
      pendingRecords: 0,
    });
  });
});
