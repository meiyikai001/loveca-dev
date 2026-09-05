import { describe, expect, it } from 'vitest';
import {
  enqueueTriggeredCardEffects,
  resolvePendingCardEffects,
} from '../../src/application/card-effect-runner';
import {
  EMMA_ON_ENTER_ACTIVATE_MEMBER_OR_ENERGY_ABILITY_ID as EMMA,
  PL_PB2_015_AUTO_BIBI_EFFECT_WAIT_OPPONENT_ACTIVATE_MEMBER_OR_ENERGY_ABILITY_ID as MAKI,
} from '../../src/application/card-effects/ability-ids';
import {
  createConfirmEffectChoiceCommand,
  createConfirmEffectStepCommand,
  createAutoAdvancePublicEffectChoiceCommand,
} from '../../src/application/game-commands';
import { createGameSession } from '../../src/application/game-session';
import { createCardInstance, type MemberCardData } from '../../src/domain/entities/card';
import {
  createGameState,
  emitGameEvent,
  registerCards,
  updatePlayer,
  type GameState,
  type PendingAbilityState,
} from '../../src/domain/entities/game';
import {
  createEnterStageEvent,
  createMemberStateChangedEvent,
  type MemberStateChangeCause,
  type MemberStateChangedEvent,
} from '../../src/domain/events/game-events';
import { placeCardInSlot, removeCardFromSlot } from '../../src/domain/entities/zone';
import {
  CardType,
  FaceState,
  OrientationState as O,
  SlotPosition as S,
  TriggerCondition as T,
  ZoneType,
} from '../../src/shared/types/enums';
import { projectPlayerViewState } from '../../src/online/projector';
import { addCheckTimingRuleSentinel } from '../helpers/check-timing-rule-sentinel';

const member = (cardCode: string, unitName = 'BiBi'): MemberCardData => ({
  cardCode,
  name: cardCode,
  unitName,
  cardType: CardType.MEMBER,
  cost: 7,
  blade: 1,
  hearts: [],
});
const cause = {
  kind: 'CARD_EFFECT' as const,
  playerId: 'p1',
  sourceCardId: 'source',
  abilityId: 'TEST_WAIT',
};
function trigger(c: MemberStateChangeCause = cause, controller = 'p2'): MemberStateChangedEvent {
  return createMemberStateChangedEvent(
    controller === 'p1' ? 'source' : 'opponent',
    controller,
    S.CENTER,
    O.ACTIVE,
    O.WAITING,
    c
  );
}
function enqueue(game: GameState, events: MemberStateChangedEvent[]) {
  for (const event of events) game = emitGameEvent(game, event);
  return enqueueTriggeredCardEffects(game, [T.ON_MEMBER_STATE_CHANGED], {
    memberStateChangedEvents: events,
  });
}
const uses = (game: GameState) =>
  game.actionHistory.filter(
    (a) => a.payload.abilityId === MAKI && a.payload.step === 'ABILITY_USE'
  );
function setup(
  ability = MAKI,
  options: { waitingEnergy?: number; energyCount?: number; marker?: boolean; member?: boolean } = {}
) {
  const source = createCardInstance(
    member(ability === MAKI ? 'PL!-pb2-015-NEW' : 'PL!N-pb1-008-P+'),
    'p1',
    'source'
  );
  const energies = Array.from({ length: options.energyCount ?? 3 }, (_, n) =>
    createCardInstance({ cardCode: `E${n}`, name: 'E', cardType: CardType.ENERGY }, 'p1', `e${n}`)
  );
  let game = registerCards(createGameState('activate-family', 'p1', 'P1', 'p2', 'P2'), [
    source,
    createCardInstance(member('TARGET'), 'p1', 'target'),
    createCardInstance(member('OTHER', 'Printemps'), 'p1', 'other'),
    createCardInstance(member('OPPONENT'), 'p2', 'opponent'),
    ...energies,
  ]);
  game = updatePlayer(game, 'p1', (p) => ({
    ...p,
    memberSlots: placeCardInSlot(p.memberSlots, S.CENTER, 'source', {
      orientation: O.ACTIVE,
      face: FaceState.FACE_UP,
    }),
    energyZone: {
      ...p.energyZone,
      cardIds: energies.map((c) => c.instanceId),
      cardStates: new Map(
        energies.map((c, n) => [
          c.instanceId,
          {
            orientation: n < (options.waitingEnergy ?? 3) ? O.WAITING : O.ACTIVE,
            face: FaceState.FACE_UP,
          },
        ])
      ),
    },
  }));
  if (options.member !== false)
    game = updatePlayer(game, 'p1', (p) => ({
      ...p,
      memberSlots: placeCardInSlot(
        placeCardInSlot(p.memberSlots, S.LEFT, 'target', {
          orientation: O.WAITING,
          face: FaceState.FACE_UP,
        }),
        S.RIGHT,
        'other',
        { orientation: O.WAITING, face: FaceState.FACE_UP }
      ),
    }));
  game = updatePlayer(game, 'p2', (p) => ({
    ...p,
    memberSlots: placeCardInSlot(p.memberSlots, S.CENTER, 'opponent', {
      orientation: O.WAITING,
      face: FaceState.FACE_UP,
    }),
  }));
  game = addCheckTimingRuleSentinel(
    addCheckTimingRuleSentinel(game, 'p1', 'family1'),
    'p2',
    'family2'
  );
  if (options.marker)
    game = {
      ...game,
      energyActivePhaseSkips: [
        {
          playerId: 'p1',
          energyCardId: `e${Math.min(2, energies.length - 1)}`,
          sourceCardId: 'marker',
          abilityId: 'marker',
        },
      ],
    };
  if (ability === MAKI) game = enqueue(game, [trigger()]);
  else
    game = {
      ...game,
      pendingAbilities: [
        {
          id: 'emma-pending',
          abilityId: EMMA,
          sourceCardId: 'source',
          controllerId: 'p1',
          mandatory: true,
          timingId: T.ON_ENTER_STAGE,
          eventIds: [],
        } satisfies PendingAbilityState,
      ],
    };
  return game;
}
function start(game: GameState) {
  let now = 10000;
  const session = createGameSession({ now: () => now });
  session.createGame('activate-family', 'p1', 'P1', 'p2', 'P2');
  const replace = (state: GameState) => {
    (session as unknown as { authorityState: GameState }).authorityState = state;
  };
  replace(resolvePendingCardEffects(game).gameState);
  const choose = (option: string) =>
    session.executeCommand(
      createConfirmEffectChoiceCommand('p1', session.state!.activeEffect!.id, {
        selectedEffectOptionIds: [option],
      })
    );
  const advance = (playerId = 'p2') => {
    const effect = session.state!.activeEffect!;
    now = effect.publicEffectChoiceAutoAdvanceAt!;
    return session.executeCommand(
      createAutoAdvancePublicEffectChoiceCommand(playerId, effect.id, now)
    );
  };
  return { session, replace, choose, advance };
}
const activatedIds = (game: GameState) =>
  game.players[0]!.energyZone.cardIds.filter(
    (id) => game.players[0]!.energyZone.cardStates.get(id)?.orientation === O.ACTIVE
  );

describe('shared activate own member or energy (Emma / Maki)', () => {
  it.each([EMMA, MAKI])(
    'publicly displays choice before %s executes member activation and preserves effect cause',
    (ability) => {
      const s = start(setup(ability));
      expect(s.session.state!.activeEffect?.effectChoice?.options.map((o) => o.id)).toEqual([
        'member',
        'energy',
      ]);
      if (ability === MAKI) expect(uses(s.session.state!)).toHaveLength(1);
      expect(s.choose('member').success).toBe(true);
      const shown = s.session.state!;
      expect(shown.activeEffect?.stepId).toBe('COMMON_PUBLIC_EFFECT_CHOICE_CONFIRMATION');
      for (const playerId of ['p1', 'p2'])
        expect(
          projectPlayerViewState(shown, playerId, { now: 10000 }).activeEffect?.effectChoice
            ?.selectedOptionIds
        ).toEqual(['member']);
      expect(shown.players[0]!.memberSlots.cardStates.get('target')?.orientation).toBe(O.WAITING);
      expect(
        s.session.executeCommand(
          createAutoAdvancePublicEffectChoiceCommand(
            'p2',
            shown.activeEffect!.id,
            shown.activeEffect!.publicEffectChoiceAutoAdvanceAt!
          )
        ).success
      ).toBe(false);
      expect(s.advance().success).toBe(true);
      expect(s.session.state!.activeEffect?.selectableCardIds).toEqual(
        ability === MAKI ? ['target'] : ['target', 'other']
      );
      expect(s.session.state!.activeEffect?.effectChoice).toBeUndefined();
      expect(
        s.session.executeCommand(
          createConfirmEffectStepCommand('p1', s.session.state!.activeEffect!.id, 'target')
        ).success
      ).toBe(true);
      expect(s.session.state!.activeEffect).toBeNull();
      expect(s.session.state!.players[0]!.memberSlots.cardStates.get('target')?.orientation).toBe(
        O.ACTIVE
      );
      const events = s.session
        .state!.eventLog.map((e) => e.event)
        .filter((e) => e.eventType === T.ON_MEMBER_STATE_CHANGED && e.cardInstanceId === 'target');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        previousOrientation: O.WAITING,
        nextOrientation: O.ACTIVE,
        cause: { kind: 'CARD_EFFECT', sourceCardId: 'source', playerId: 'p1', abilityId: ability },
      });
      if (ability === MAKI) expect(uses(s.session.state!)).toHaveLength(1);
    }
  );
  it.each([0, 1, 2, 3])(
    'activates the actual first up to two WAITING ordinary energies from %s available',
    (count) => {
      const s = start(setup(MAKI, { waitingEnergy: count }));
      expect(s.choose('energy').success).toBe(true);
      expect(s.advance().success).toBe(true);
      expect(s.session.state!.activeEffect).toBeNull();
      const action = s.session.state!.actionHistory.find(
        (a) => a.payload.step === 'ACTIVATE_ENERGY'
      );
      expect(action?.payload.activatedEnergyCardIds).toEqual(
        Array.from({ length: Math.min(2, count) }, (_, n) => `e${n}`)
      );
      expect(uses(s.session.state!)).toHaveLength(1);
    }
  );
  it('opens exact energy selection for excess special energy and rejects duplicate, invalid and stale targets', () => {
    const s = start(setup(MAKI, { marker: true }));
    expect(s.choose('energy').success).toBe(true);
    expect(s.advance().success).toBe(true);
    expect(s.session.state!.activeEffect).toMatchObject({
      stepId: 'COMMON_ENERGY_OPERATION_SELECTION',
      selectableCardIds: ['e0', 'e1', 'e2'],
      minSelectableCards: 2,
      maxSelectableCards: 2,
    });
    expect(activatedIds(s.session.state!)).toEqual([]);
    for (const ids of [['e2', 'e2'], ['e2', 'invalid'], ['e2']]) {
      expect(
        s.session.executeCommand(
          createConfirmEffectStepCommand(
            'p1',
            s.session.state!.activeEffect!.id,
            undefined,
            undefined,
            undefined,
            undefined,
            ids
          )
        ).success
      ).toBe(false);
      expect(activatedIds(s.session.state!)).toEqual([]);
    }
    const before = s.session.state!;
    s.replace(
      updatePlayer(before, 'p1', (p) => ({
        ...p,
        energyZone: { ...p.energyZone, cardIds: ['e0', 'e1'] },
      }))
    );
    expect(
      s.session.executeCommand(
        createConfirmEffectStepCommand(
          'p1',
          s.session.state!.activeEffect!.id,
          undefined,
          undefined,
          undefined,
          undefined,
          ['e2', 'e1']
        )
      ).success
    ).toBe(false);
    s.replace(before);
    expect(
      s.session.executeCommand(
        createConfirmEffectStepCommand(
          'p1',
          s.session.state!.activeEffect!.id,
          undefined,
          undefined,
          undefined,
          undefined,
          ['e2', 'e1']
        )
      ).success
    ).toBe(true);
    expect(activatedIds(s.session.state!)).toEqual(['e1', 'e2']);
    expect(
      s.session.state!.actionHistory.find((a) => a.payload.step === 'ACTIVATE_ENERGY')?.payload
        .activatedEnergyCardIds
    ).toEqual(['e2', 'e1']);
    expect(uses(s.session.state!)).toHaveLength(1);
  });
  it.each([1, 2])(
    'activates all %s available special energies directly when candidates do not exceed the effect count',
    (count) => {
      const s = start(setup(MAKI, { marker: true, energyCount: count, waitingEnergy: count }));
      expect(s.choose('energy').success).toBe(true);
      expect(s.advance().success).toBe(true);
      expect(s.session.state!.activeEffect).toBeNull();
      expect(
        s.session.state!.actionHistory.find((a) => a.payload.step === 'ACTIVATE_ENERGY')?.payload
          .activatedEnergyCardIds
      ).toEqual(Array.from({ length: count }, (_, n) => `e${n}`));
    }
  );
  it.each(['member', 'energy'])(
    'allows an empty %s branch and consumes the AUTO turn use at start',
    (option) => {
      const s = start(setup(MAKI, { energyCount: 0, member: false }));
      expect(s.session.state!.activeEffect?.effectChoice?.options.every((o) => o.selectable)).toBe(
        true
      );
      expect(uses(s.session.state!)).toHaveLength(1);
      expect(s.choose(option).success).toBe(true);
      expect(s.advance().success).toBe(true);
      expect(s.session.state!.activeEffect).toBeNull();
      expect(uses(s.session.state!)).toHaveLength(1);
      expect(enqueue(s.session.state!, [trigger()]).pendingAbilities).toEqual([]);
    }
  );
  it('target loss during public display finishes the chosen branch and source loss does not prevent activating another member', () => {
    const s = start(setup());
    expect(s.choose('member').success).toBe(true);
    s.replace(
      updatePlayer(s.session.state!, 'p1', (p) => ({
        ...p,
        memberSlots: removeCardFromSlot(p.memberSlots, S.LEFT),
      }))
    );
    expect(s.advance().success).toBe(true);
    expect(s.session.state!.activeEffect).toBeNull();
    const other = start(setup());
    expect(other.choose('member').success).toBe(true);
    other.replace(
      updatePlayer(other.session.state!, 'p1', (p) => ({
        ...p,
        memberSlots: removeCardFromSlot(p.memberSlots, S.CENTER),
      }))
    );
    expect(other.advance().success).toBe(true);
    expect(
      other.session.executeCommand(
        createConfirmEffectStepCommand('p1', other.session.state!.activeEffect!.id, 'target')
      ).success
    ).toBe(true);
    expect(other.session.state!.players[0]!.memberSlots.cardStates.get('target')?.orientation).toBe(
      O.ACTIVE
    );
    expect(uses(other.session.state!)).toHaveLength(1);
  });
});

describe('PL!-pb2-015 费用7 西木野真姬 BiBi state-event observer', () => {
  it('uses own BiBi cause, not opponent/player/rule cause or own affected member', () => {
    const base = { ...setup(), pendingAbilities: [] };
    const rejected = enqueue(base, [
      trigger({ kind: 'RULE_ACTION', playerId: 'p1' }),
      trigger({ kind: 'PLAYER_ACTION', playerId: 'p1' }),
      trigger({ ...cause, playerId: 'p2' }),
      trigger({ ...cause, sourceCardId: 'other' }),
      trigger(cause, 'p1'),
    ]);
    expect(rejected.pendingAbilities).toEqual([]);
    expect(enqueue(base, [trigger()]).pendingAbilities).toHaveLength(1);
  });
  it('reserves once per lifecycle and turn, deduplicates the exact event and only queues during another active effect', () => {
    let game = { ...setup(), pendingAbilities: [] };
    const event = trigger();
    const active = {
      id: 'ongoing',
      abilityId: 'ongoing',
      sourceCardId: 'other',
      controllerId: 'p1',
      awaitingPlayerId: 'p1',
      effectText: 'test',
      stepId: 'TEST',
    };
    game = enqueue({ ...game, activeEffect: active }, [event, event, trigger()]);
    expect(game.pendingAbilities).toHaveLength(1);
    expect(game.activeEffect).toEqual(active);
    const s = start({ ...game, activeEffect: null });
    expect(s.choose('energy').success).toBe(true);
    expect(s.advance().success).toBe(true);
    expect(enqueue(s.session.state!, [event, trigger()]).pendingAbilities).toEqual([]);
    const nextTurn = { ...s.session.state!, turnCount: s.session.state!.turnCount + 1 };
    expect(enqueue(nextTurn, [event]).pendingAbilities).toEqual([]);
    expect(enqueue(nextTurn, [trigger()]).pendingAbilities).toHaveLength(1);
    const reentered = emitGameEvent(
      s.session.state!,
      createEnterStageEvent('source', ZoneType.WAITING_ROOM, S.CENTER, 'p1', 'p1')
    );
    expect(enqueue(reentered, [trigger()]).pendingAbilities).toHaveLength(1);
  });
});
