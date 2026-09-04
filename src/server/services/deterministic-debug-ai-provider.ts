import type {
  AiDecisionProviderV2,
  AiEffectCardSelectionWindowV2,
} from '../../application/ai/ai-decision-contract.js';
import { matchesSelectionGroups } from '../../application/effects/card-selection-groups.js';
import { CardType } from '../../shared/types/enums.js';

const MAX_DEBUG_SELECTION_CANDIDATES = 256;
const MAX_DEBUG_SELECTION_SEARCH_NODES = 4_096;
const DEBUG_SELECTION_SEARCH_BUDGET_MS = 25;

/**
 * Remote debug 专用的确定性测试 bot。它只消费 AI 决策协议中的匿名 token，
 * 不接受路由调用方提供的命令或 provider。
 */
export function createDeterministicDebugAiProvider(): AiDecisionProviderV2 {
  const activationAttemptsBySeat = new Map<
    string,
    { readonly turnCount: number; readonly signatures: Set<string> }
  >();
  return {
    decide(request) {
      if (request.window.kind === 'EFFECT_CARD_SELECTION') {
        const selectedCardTokens = findDebugCardSelection(request.window);
        const decisionBase = {
          schemaVersion: request.schemaVersion,
          decisionId: request.decisionId,
          contextDigest: request.contextDigest,
          kind: 'EFFECT_CARD_SELECTION' as const,
        };
        return Promise.resolve(
          selectedCardTokens !== null
            ? { ...decisionBase, choice: 'SELECT' as const, selectedCardTokens }
            : request.window.canSkip
              ? { ...decisionBase, choice: 'SKIP' as const }
              : null
        );
      }

      if (request.window.kind === 'LIVE_ACTION') {
        const observation = request.observation;
        if (!('live' in observation)) return Promise.resolve(null);
        const candidates = request.window.candidates;
        const confirmLiveSet = candidates.find(
          (candidate) => candidate.kind === 'CONFIRM_LIVE_SET'
        );
        const hasLiveCard = observation.live.players
          .find((player) => player.seat === observation.match.viewerSeat)
          ?.liveCards.some((entry) => entry.card?.cardType === CardType.LIVE);
        const firstLivePlacement = candidates.find(
          (candidate) =>
            candidate.kind === 'SET_LIVE_CARD' &&
            observation.self.hand.some(
              (entry) =>
                entry.handToken === candidate.sourceHandToken &&
                entry.card.cardType === CardType.LIVE
            )
        );
        // 固定测试 bot 只盖一张 LIVE，不补伪装卡；判定与分数始终接受权威候选。
        const selectedCandidate = confirmLiveSet
          ? hasLiveCard
            ? confirmLiveSet
            : (firstLivePlacement ?? confirmLiveSet)
          : (candidates.find((candidate) => candidate.kind === 'SELECT_SUCCESS_LIVE') ??
            candidates[0]);
        return Promise.resolve(
          selectedCandidate
            ? {
                schemaVersion: request.schemaVersion,
                decisionId: request.decisionId,
                contextDigest: request.contextDigest,
                kind: 'LIVE_ACTION',
                selectedActionToken: selectedCandidate.actionToken,
              }
            : null
        );
      }

      if (request.window.kind === 'EFFECT_STEP') {
        // 仅用于逐步验证链路：按候选顺序选首个非跳过动作，不表达卡效策略。
        const selectedCandidate =
          request.window.candidates.find((candidate) => candidate.kind !== 'SKIP') ??
          request.window.candidates[0];

        return Promise.resolve(
          selectedCandidate
            ? {
                schemaVersion: request.schemaVersion,
                decisionId: request.decisionId,
                contextDigest: request.contextDigest,
                kind: 'EFFECT_STEP',
                selectedActionToken: selectedCandidate.actionToken,
              }
            : null
        );
      }

      if (request.window.kind === 'MAIN_ACTION') {
        const { viewerSeat, turnCount } = request.observation.match;
        let attempts = activationAttemptsBySeat.get(viewerSeat);
        if (!attempts || attempts.turnCount !== turnCount) {
          attempts = { turnCount, signatures: new Set() };
          activationAttemptsBySeat.set(viewerSeat, attempts);
        }
        // 纯 debug 策略：同回合、同席位、同槽位/文本只尝试一次，在返回决定时
        // 就记下；即使声明被拒绝、被跳过或状态变化也不重试，避免零费起动循环。
        const untriedActivation = request.window.candidates.find(
          (candidate) =>
            candidate.kind === 'ACTIVATE_ABILITY' &&
            !attempts.signatures.has(JSON.stringify([candidate.sourceSlot, candidate.abilityText]))
        );
        if (untriedActivation?.kind === 'ACTIVATE_ABILITY') {
          attempts.signatures.add(
            JSON.stringify([untriedActivation.sourceSlot, untriedActivation.abilityText])
          );
        }
        const selectedCandidate =
          untriedActivation ??
          request.window.candidates.find(
            (candidate) => candidate.kind === 'PLAY_MEMBER_TO_EMPTY_SLOT'
          ) ??
          request.window.candidates.find(
            (candidate) => candidate.kind === 'PLAY_MEMBER_WITH_SINGLE_RELAY'
          ) ??
          request.window.candidates.find((candidate) => candidate.kind === 'END_MAIN_PHASE');

        return Promise.resolve(
          selectedCandidate
            ? {
                schemaVersion: request.schemaVersion,
                decisionId: request.decisionId,
                contextDigest: request.contextDigest,
                kind: 'MAIN_ACTION',
                selectedActionToken: selectedCandidate.actionToken,
              }
            : null
        );
      }

      return Promise.resolve({
        schemaVersion: request.schemaVersion,
        decisionId: request.decisionId,
        contextDigest: request.contextDigest,
        kind: 'MULLIGAN',
        selectedCardTokens: request.window.candidates.map((candidate) => candidate.token),
      });
    },
  };
}

/** 只寻找一组公开约束内的测试输入，不求最优，也不预测原 workflow 的其他限制。 */
function findDebugCardSelection(window: AiEffectCardSelectionWindowV2): readonly string[] | null {
  if (
    window.candidates.length > MAX_DEBUG_SELECTION_CANDIDATES ||
    (window.groups?.length ?? 0) > MAX_DEBUG_SELECTION_CANDIDATES ||
    !Number.isInteger(window.minSelections) ||
    !Number.isInteger(window.maxSelections) ||
    window.minSelections < 0 ||
    window.maxSelections < window.minSelections
  ) {
    return null;
  }
  const tokens = window.candidates.map((candidate) => candidate.cardToken);
  if (new Set(tokens).size !== tokens.length) return null;
  const maxSelections = Math.min(window.maxSelections, tokens.length);
  const groups = window.groups?.map((group) => ({
    candidateCardIds: group.candidateCardTokens,
    minCount: group.minCount,
    maxCount: group.maxCount,
  }));
  const rejectedSelections = new Set(
    window.rejectedSelections.map((tokens) => JSON.stringify(tokens))
  );
  const deadline = globalThis.performance.now() + DEBUG_SELECTION_SEARCH_BUDGET_MS;
  let visitedNodes = 0;
  let exhausted = false;
  const selected: string[] = [];
  const used = new Set<string>();
  const search = (targetCount: number): readonly string[] | null => {
    if (
      visitedNodes >= MAX_DEBUG_SELECTION_SEARCH_NODES ||
      globalThis.performance.now() >= deadline
    ) {
      exhausted = true;
      return null;
    }
    visitedNodes += 1;
    if (selected.length === targetCount) {
      return !rejectedSelections.has(JSON.stringify(selected)) &&
        matchesSelectionGroups(selected, groups, window.distinctGroupAssignment)
        ? [...selected]
        : null;
    }
    for (const token of tokens) {
      if (used.has(token)) continue;
      selected.push(token);
      used.add(token);
      const result = search(targetCount);
      used.delete(token);
      selected.pop();
      if (result !== null) return result;
      if (exhausted) return null;
    }
    return null;
  };
  // 有序搜索允许 [A, B] 被实际规则拒绝后改试 [B, A]；全请求共享硬预算。
  for (let count = window.minSelections; count <= maxSelections; count += 1) {
    const result = search(count);
    if (result !== null) return result;
    if (exhausted) break;
  }
  return null;
}
