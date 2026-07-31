import { describe, expect, it, vi } from 'vitest';
import {
  createGameState,
  emitGameEvent,
  type ActiveEffectState,
  type GameState,
  type PendingAbilityState,
} from '../../src/domain/entities/game';
import { createEnterStageEvent, createLeaveStageEvent } from '../../src/domain/events/game-events';
import { HANAYO_ACTIVATED_ABILITY_ID } from '../../src/application/card-effects/ability-ids';
import {
  capturePendingAbilitySourceLifecycles,
  getAbilitySourceLifecycleId,
} from '../../src/application/card-effects/runtime/ability-source-lifecycle';
import {
  beginPendingAbilityResolution,
  finishPendingAbilityResolution,
  type PendingAbilityResolutionOutcome,
} from '../../src/application/card-effects/runtime/pending-ability-resolution';
import { recordAbilityUseForContext } from '../../src/application/card-effects/runtime/workflow-helpers';
import { GamePhase, SlotPosition, TriggerCondition, ZoneType } from '../../src/shared/types/enums';

const PENDING: PendingAbilityState = {
  id: 'pending-1',
  abilityId: 'test:ability',
  sourceCardId: 'source-1',
  sourceLifecycleId: 'source-lifecycle-1',
  controllerId: 'p1',
  mandatory: true,
  timingId: TriggerCondition.ON_ENTER_STAGE,
  eventIds: ['event-1'],
  sourceSlot: SlotPosition.CENTER,
};

function createGameWithPending(...pendingAbilities: readonly PendingAbilityState[]): GameState {
  return {
    ...createGameState('pending-resolution', 'p1', 'P1', 'p2', 'P2'),
    pendingAbilities,
  };
}

function begin(game: GameState, ability: PendingAbilityState = PENDING, orderedResolution = false) {
  const result = beginPendingAbilityResolution(game, ability, { orderedResolution });
  if (result.status !== 'BEGUN') {
    throw new Error(`Expected pending resolution to begin, got ${result.reason}`);
  }
  return result;
}

describe('pending ability resolution runtime helper', () => {
  it('consumes only the exact pending instance and preserves similar pending abilities', () => {
    const similarAbility = {
      ...PENDING,
      id: 'pending-2',
      eventIds: ['event-2'],
    };
    const otherSource = {
      ...PENDING,
      id: 'pending-3',
      sourceCardId: 'source-2',
      sourceLifecycleId: 'source-lifecycle-2',
    };

    const result = begin(createGameWithPending(PENDING, similarAbility, otherSource));

    expect(result.gameState.pendingAbilities).toEqual([similarAbility, otherSource]);
    expect(result.receipt).toMatchObject({
      pendingAbilityId: PENDING.id,
      abilityId: PENDING.abilityId,
      sourceCardId: PENDING.sourceCardId,
      sourceLifecycleId: PENDING.sourceLifecycleId,
      controllerId: PENDING.controllerId,
      timingId: PENDING.timingId,
      eventIds: PENDING.eventIds,
      sourceSlot: PENDING.sourceSlot,
    });
  });

  it('makes identity mismatches explicit without consuming anything', () => {
    const game = createGameWithPending(PENDING);

    const result = beginPendingAbilityResolution(
      game,
      {
        ...PENDING,
        sourceCardId: 'wrong-source',
      },
      { orderedResolution: false }
    );

    expect(result).toMatchObject({
      status: 'NO_PROGRESS',
      reason: 'PENDING_IDENTITY_MISMATCH',
      gameState: game,
    });
    expect(result.gameState.pendingAbilities).toEqual([PENDING]);
  });

  it('reports a missing pending without changing state', () => {
    const game = createGameWithPending();

    const result = beginPendingAbilityResolution(game, PENDING, {
      orderedResolution: true,
    });

    expect(result).toMatchObject({
      status: 'NO_PROGRESS',
      reason: 'PENDING_NOT_FOUND',
      gameState: game,
    });
  });

  it('normalizes omitted legacy eventIds to an empty receipt sequence', () => {
    const legacyPending = {
      ...PENDING,
      eventIds: undefined,
    } as unknown as PendingAbilityState;

    const result = begin(createGameWithPending(legacyPending), legacyPending);

    expect(result.receipt.eventIds).toEqual([]);
    expect(result.gameState.pendingAbilities).toEqual([]);
  });

  it.each([
    ['SUCCESS', 'APPLIED', true],
    ['NO_OP', 'NO_VALID_TARGET', false],
    ['STALE', 'SOURCE_LEFT_ZONE', true],
    ['SKIP', 'DECLINED', false],
  ] as const satisfies readonly (readonly [PendingAbilityResolutionOutcome, string, boolean])[])(
    'writes a complete %s audit and passes orderedResolution=%s through unchanged',
    (outcome, step, orderedResolution) => {
      const begun = begin(createGameWithPending(PENDING), PENDING, orderedResolution);
      const continuation = vi.fn((state: GameState) => state);

      const result = finishPendingAbilityResolution(
        begun.gameState,
        begun.receipt,
        {
          outcome,
          step,
          actionPayload: { detail: 'kept' },
        },
        continuation
      );

      expect(result.status).toBe('FINISHED');
      expect(continuation).toHaveBeenCalledTimes(1);
      expect(continuation).toHaveBeenCalledWith(expect.any(Object), orderedResolution);
      expect(result.gameState.actionHistory.at(-1)).toMatchObject({
        type: 'RESOLVE_ABILITY',
        playerId: PENDING.controllerId,
        payload: {
          pendingAbilityId: PENDING.id,
          abilityId: PENDING.abilityId,
          sourceCardId: PENDING.sourceCardId,
          sourceLifecycleId: PENDING.sourceLifecycleId,
          controllerId: PENDING.controllerId,
          mandatory: PENDING.mandatory,
          timingId: PENDING.timingId,
          eventIds: PENDING.eventIds,
          sourceSlot: PENDING.sourceSlot,
          pendingSourceSlot: PENDING.sourceSlot,
          pendingResolutionBeganAtActionSequence: 0,
          resolutionOutcome: outcome,
          pendingResolutionComplete: true,
          orderedResolution,
          step,
          detail: 'kept',
        },
      });
    }
  );

  it('keeps a workflow sourceSlot fact distinct from the pending source-slot identity', () => {
    const begun = begin(createGameWithPending(PENDING));

    const result = finishPendingAbilityResolution(
      begun.gameState,
      begun.receipt,
      {
        outcome: 'SUCCESS',
        step: 'MOVED',
        actionPayload: { sourceSlot: SlotPosition.RIGHT },
      },
      (state) => state
    );

    expect(result.gameState.actionHistory.at(-1)?.payload).toMatchObject({
      sourceSlot: SlotPosition.RIGHT,
      pendingSourceSlot: SlotPosition.CENTER,
    });
  });

  it('keeps ability-use and completion audits on the lifecycle captured before stage re-entry', () => {
    let game = createGameWithPending();
    const firstEntry = createEnterStageEvent(
      PENDING.sourceCardId,
      ZoneType.HAND,
      SlotPosition.CENTER,
      PENDING.controllerId,
      PENDING.controllerId
    );
    game = emitGameEvent(game, firstEntry);

    const uncapturedPending: PendingAbilityState = {
      ...PENDING,
      abilityId: HANAYO_ACTIVATED_ABILITY_ID,
      sourceLifecycleId: undefined,
      eventIds: [firstEntry.eventId],
    };
    game = capturePendingAbilitySourceLifecycles({
      ...game,
      pendingAbilities: [uncapturedPending],
    });
    const capturedPending = game.pendingAbilities[0];
    if (!capturedPending?.sourceLifecycleId) {
      throw new Error('Expected pending source lifecycle to be captured');
    }
    const oldLifecycle = capturedPending.sourceLifecycleId;
    const begun = begin(game, capturedPending, true);

    let reentered = emitGameEvent(
      begun.gameState,
      createLeaveStageEvent(
        capturedPending.sourceCardId,
        SlotPosition.CENTER,
        ZoneType.WAITING_ROOM,
        capturedPending.controllerId,
        capturedPending.controllerId
      )
    );
    const secondEntry = createEnterStageEvent(
      capturedPending.sourceCardId,
      ZoneType.WAITING_ROOM,
      SlotPosition.CENTER,
      capturedPending.controllerId,
      capturedPending.controllerId
    );
    reentered = emitGameEvent(reentered, secondEntry);
    const newLifecycle = getAbilitySourceLifecycleId(
      reentered,
      capturedPending.abilityId,
      capturedPending.sourceCardId
    );

    expect(newLifecycle).not.toBe(oldLifecycle);
    expect(newLifecycle).toContain(secondEntry.eventId);
    expect(begun.receipt.sourceLifecycleId).toBe(oldLifecycle);

    const withAbilityUse = recordAbilityUseForContext(reentered, begun.receipt.controllerId, {
      abilityId: begun.receipt.abilityId,
      sourceCardId: begun.receipt.sourceCardId,
      sourceLifecycleId: begun.receipt.sourceLifecycleId,
      pendingAbilityId: begun.receipt.pendingAbilityId,
    });
    const finished = finishPendingAbilityResolution(
      withAbilityUse,
      begun.receipt,
      {
        outcome: 'SUCCESS',
        step: 'APPLIED_AFTER_REENTRY',
      },
      (state) => state
    );

    expect(finished.status).toBe('FINISHED');
    const abilityUse = finished.gameState.actionHistory.find(
      (action) =>
        action.type === 'RESOLVE_ABILITY' &&
        action.payload.pendingAbilityId === capturedPending.id &&
        action.payload.step === 'ABILITY_USE'
    );
    const completion = finished.gameState.actionHistory.find(
      (action) =>
        action.type === 'RESOLVE_ABILITY' &&
        action.payload.pendingAbilityId === capturedPending.id &&
        action.payload.pendingResolutionComplete === true
    );

    expect(abilityUse?.payload.sourceLifecycleId).toBe(oldLifecycle);
    expect(completion?.payload.sourceLifecycleId).toBe(oldLifecycle);
    expect(abilityUse?.payload.sourceLifecycleId).not.toBe(newLifecycle);
    expect(completion?.payload.sourceLifecycleId).not.toBe(newLifecycle);
  });

  it('clears only an active effect with the same pending/source/lifecycle identity', () => {
    const begun = begin(createGameWithPending(PENDING));
    const activeEffect: ActiveEffectState = {
      id: PENDING.id,
      abilityId: PENDING.abilityId,
      sourceCardId: PENDING.sourceCardId,
      sourceLifecycleId: PENDING.sourceLifecycleId,
      controllerId: PENDING.controllerId,
      effectText: 'test',
      stepId: 'TEST',
      stepText: 'test',
      awaitingPlayerId: PENDING.controllerId,
    };
    const game = { ...begun.gameState, activeEffect };
    const continuation = vi.fn((state: GameState) => state);

    const result = finishPendingAbilityResolution(
      game,
      begun.receipt,
      {
        outcome: 'SKIP',
        step: 'SKIP',
        clearMatchingActiveEffect: true,
      },
      continuation
    );

    expect(result.status).toBe('FINISHED');
    expect(result.gameState.activeEffect).toBeNull();
    expect(continuation).toHaveBeenCalledTimes(1);
  });

  it('does not clear, audit, or continue when the active-effect identity mismatches', () => {
    const begun = begin(createGameWithPending(PENDING));
    const activeEffect: ActiveEffectState = {
      id: PENDING.id,
      abilityId: PENDING.abilityId,
      sourceCardId: PENDING.sourceCardId,
      sourceLifecycleId: 'different-lifecycle',
      controllerId: PENDING.controllerId,
      effectText: 'test',
      stepId: 'TEST',
      stepText: 'test',
      awaitingPlayerId: PENDING.controllerId,
    };
    const game = { ...begun.gameState, activeEffect };
    const continuation = vi.fn((state: GameState) => state);

    const result = finishPendingAbilityResolution(
      game,
      begun.receipt,
      {
        outcome: 'SKIP',
        step: 'SKIP',
        clearMatchingActiveEffect: true,
      },
      continuation
    );

    expect(result).toMatchObject({
      status: 'NO_PROGRESS',
      reason: 'ACTIVE_EFFECT_IDENTITY_MISMATCH',
      gameState: game,
    });
    expect(result.gameState.activeEffect).toBe(activeEffect);
    expect(result.gameState.actionHistory).toHaveLength(0);
    expect(continuation).not.toHaveBeenCalled();
  });

  it('presents newly produced events and pending abilities to continuation before it runs', () => {
    const begun = begin(createGameWithPending(PENDING));
    const nextPending: PendingAbilityState = {
      ...PENDING,
      id: 'pending-next',
      abilityId: 'test:next',
      eventIds: ['event-next'],
    };
    const stateWithNewWork: GameState = {
      ...begun.gameState,
      pendingAbilities: [nextPending],
      eventLog: [
        {
          sequence: 1,
          event: {
            eventId: 'event-next',
            eventType: TriggerCondition.ON_TURN_START,
            timestamp: 1,
            triggerPlayerId: 'p1',
            turnNumber: 1,
            currentPlayerId: 'p1',
          },
        },
      ],
      eventSequence: 1,
      currentPhase: GamePhase.MAIN_PHASE,
    };
    const continuation = vi.fn((state: GameState) => {
      expect(state.pendingAbilities).toEqual([nextPending]);
      expect(state.eventLog.map((entry) => entry.event.eventId)).toEqual(['event-next']);
      return state;
    });

    const result = finishPendingAbilityResolution(
      stateWithNewWork,
      begun.receipt,
      {
        outcome: 'SUCCESS',
        step: 'PRODUCED_NEW_WORK',
      },
      continuation
    );

    expect(result.status).toBe('FINISHED');
    expect(continuation).toHaveBeenCalledTimes(1);
  });

  it('does not audit or invoke continuation twice when completion is replayed', () => {
    const begun = begin(createGameWithPending(PENDING));
    const continuation = vi.fn((state: GameState) => state);
    const options = {
      outcome: 'SUCCESS' as const,
      step: 'APPLIED',
    };

    const first = finishPendingAbilityResolution(
      begun.gameState,
      begun.receipt,
      options,
      continuation
    );
    const second = finishPendingAbilityResolution(
      first.gameState,
      begun.receipt,
      options,
      continuation
    );

    expect(first.status).toBe('FINISHED');
    expect(second).toMatchObject({
      status: 'NO_PROGRESS',
      reason: 'ALREADY_FINISHED',
      gameState: first.gameState,
    });
    expect(continuation).toHaveBeenCalledTimes(1);
    expect(
      second.gameState.actionHistory.filter(
        (action) =>
          action.type === 'RESOLVE_ABILITY' &&
          action.payload.pendingAbilityId === PENDING.id &&
          action.payload.pendingResolutionComplete === true
      )
    ).toHaveLength(1);
  });

  it('refuses to finish against a state that still contains the consumed pending id', () => {
    const gameBeforeBegin = createGameWithPending(PENDING);
    const begun = begin(gameBeforeBegin);
    const continuation = vi.fn((state: GameState) => state);

    const result = finishPendingAbilityResolution(
      gameBeforeBegin,
      begun.receipt,
      {
        outcome: 'SUCCESS',
        step: 'WRONG_STATE_BRANCH',
      },
      continuation
    );

    expect(result).toMatchObject({
      status: 'NO_PROGRESS',
      reason: 'PENDING_STILL_PRESENT',
      gameState: gameBeforeBegin,
    });
    expect(result.gameState.pendingAbilities).toEqual([PENDING]);
    expect(result.gameState.actionHistory).toHaveLength(0);
    expect(continuation).not.toHaveBeenCalled();
  });
});
