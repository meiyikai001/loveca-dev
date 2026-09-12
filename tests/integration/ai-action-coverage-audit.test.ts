import { describe, expect, it } from 'vitest';
import { buildAiDecisionFrameV2 } from '../../src/application/ai/ai-decision-frame';
import { getCardAbilityDefinitions } from '../../src/application/card-effect-runner';
import { GameCommandType } from '../../src/application/game-commands';
import { createGameSession } from '../../src/application/game-session';
import {
  createCardInstance,
  createHeartRequirement,
  type AnyCardData,
} from '../../src/domain/entities/card';
import {
  CardType,
  FaceState,
  GamePhase,
  OrientationState,
  SlotPosition,
  SubPhase,
} from '../../src/shared/types/enums';

const PLAYER = 'coverage-player';
const OTHER = 'coverage-other';

// Only owned cards and empty opponent zones are seeded. These are action-window
// fixtures, not full-deck/card-effect correctness or natural-game evidence.
function scenario(card: AnyCardData, phase: GamePhase, subPhase: SubPhase) {
  const session = createGameSession();
  const state = session.createGame('ai-coverage-audit', PLAYER, '玩家', OTHER, '对手');
  Object.assign(state, {
    currentPhase: phase,
    currentSubPhase: subPhase,
    firstPlayerIndex: 0,
    activePlayerIndex: 0,
    waitingPlayerId: null,
  });
  const source = createCardInstance(card, PLAYER, 'coverage-own-source');
  (state.cardRegistry as Map<string, typeof source>).set(source.instanceId, source);
  return { session, source };
}

describe('首版绿莲动作覆盖审计夹具', () => {
  it.each([
    ['PL!HS-PR-014-RM', '日野下花帆', 2],
    ['PL!HS-sd1-009-SD', '日野下花帆', 2],
    ['PL!HS-bp5-001-SEC', '日野下花帆', 11],
    ['PL!HS-bp1-003-SEC', '乙宗梢', 13],
    ['PL!HS-bp1-002-RM', '村野沙耶香', 11],
  ] as const)('%s 的舞台起动进入匿名声明；不据此承诺费用和目标可执行', (cardCode, name, cost) => {
    const { session, source } = scenario(
      { cardCode, name, cost, cardType: CardType.MEMBER, blade: 0, hearts: [] },
      GamePhase.MAIN_PHASE,
      SubPhase.NONE
    );
    const slots = session.state!.players[0].memberSlots;
    Object.assign(slots.slots, { [SlotPosition.CENTER]: source.instanceId });
    (slots.cardStates as Map<string, object>).set(source.instanceId, {
      face: FaceState.FACE_UP,
      orientation: OrientationState.ACTIVE,
    });
    const actions = session.getRulesMainActionCandidates(PLAYER);
    const declarations = actions.filter((action) => action.kind === 'ACTIVATE_ABILITY');
    const definition = getCardAbilityDefinitions(cardCode).find(
      (ability) => ability.category === 'ACTIVATED'
    );
    expect(definition).toBeDefined();
    expect(declarations).toHaveLength(1);
    expect(declarations[0]!.binding.abilityId).toBe(definition!.abilityId);

    const result = buildAiDecisionFrameV2(
      session.getPlayerViewState(PLAYER)!,
      'audit-main',
      actions
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.frame.request.window.kind !== 'MAIN_ACTION')
      throw new Error('main frame');
    expect(
      result.frame.request.window.candidates.filter((c) => c.kind === 'ACTIVATE_ABILITY')
    ).toEqual([
      expect.objectContaining({ sourceSlot: SlotPosition.CENTER, legality: 'DECLARATION_ONLY' }),
    ]);
    expect(JSON.stringify(result.frame.request)).not.toContain(source.instanceId);
    expect(JSON.stringify(result.frame.request)).not.toContain(definition!.abilityId);
  });

  it.each<AnyCardData>([
    {
      cardCode: 'PL!HS-sd1-012-SD',
      name: '百生吟子',
      cardType: CardType.MEMBER,
      cost: 4,
      blade: 0,
      hearts: [],
    },
    {
      cardCode: 'PL!HS-bp2-022-L+',
      name: 'アオクハルカ',
      cardType: CardType.LIVE,
      score: 2,
      requirements: createHeartRequirement({}),
    },
  ])('$cardCode 盖下后原命令可撤回，当前 AI 没有对应动作', (card) => {
    const { session, source } = scenario(
      card,
      GamePhase.LIVE_SET_PHASE,
      SubPhase.LIVE_SET_FIRST_PLAYER
    );
    Object.assign(session.state!.players[0].hand, { cardIds: [source.instanceId] });
    expect(
      session.executeCommand({
        type: GameCommandType.SET_LIVE_CARD,
        playerId: PLAYER,
        cardId: source.instanceId,
        faceDown: true,
        timestamp: 1,
      }).success
    ).toBe(true);

    const view = session.getPlayerViewState(PLAYER)!;
    expect(view.permissions.availableCommands).toContainEqual(
      expect.objectContaining({
        command: GameCommandType.UNSET_LIVE_CARD,
        enabled: true,
      })
    );
    const actions = session.getLegalRulesLiveActions(PLAYER);
    expect(actions.map((action) => action.kind)).toEqual(['CONFIRM_LIVE_SET']);
    const result = buildAiDecisionFrameV2(view, 'audit-live', [], [], actions);
    expect(result.ok).toBe(true);
    if (
      !result.ok ||
      result.frame.request.window.kind !== 'LIVE_ACTION' ||
      !('live' in result.frame.request.observation)
    )
      throw new Error('live frame');
    expect(result.frame.request.window.candidates).toEqual([
      expect.objectContaining({ kind: 'CONFIRM_LIVE_SET' }),
    ]);
    expect(result.frame.request.observation.live.players[0]!.liveCards[0]!.card?.cardCode).toBe(
      card.cardCode
    );

    // One selected original command, not a candidate trial loop or resolver probe.
    expect(
      session.executeCommand({
        type: GameCommandType.UNSET_LIVE_CARD,
        playerId: PLAYER,
        cardId: source.instanceId,
        timestamp: 2,
      }).success
    ).toBe(true);
    expect(session.state!.players[0].hand.cardIds).toEqual([source.instanceId]);
    expect(session.state!.players[0].liveZone.cardIds).toEqual([]);
    expect(session.state!.liveSetCardIds?.get(PLAYER)).toEqual([]);
    expect(session.state!.currentSubPhase).toBe(SubPhase.LIVE_SET_FIRST_PLAYER);
    expect(session.state!.players[0].mainDeck.cardIds).toEqual([]);
  });
});
