import type { AiDecisionProviderV2 } from '../../application/ai/ai-decision-contract.js';

/**
 * Remote debug 专用的确定性策略。它只消费 AI 决策协议中的匿名 token，
 * 不接受路由调用方提供的命令或 provider。
 */
export const deterministicDebugAiProvider: AiDecisionProviderV2 = {
  decide(request) {
    if (request.window.kind === 'MAIN_ACTION') {
      const selectedCandidate =
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
