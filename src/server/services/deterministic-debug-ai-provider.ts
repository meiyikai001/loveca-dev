import type { AiDecisionProvider } from '../../application/ai/ai-decision-contract.js';

/**
 * Remote debug 专用的确定性策略。它只消费 AI 决策协议中的匿名 token，
 * 不接受路由调用方提供的命令或 provider。
 */
export const deterministicDebugAiProvider: AiDecisionProvider = {
  decide(request) {
    return Promise.resolve({
      schemaVersion: request.schemaVersion,
      decisionId: request.decisionId,
      kind: 'MULLIGAN',
      selectedCardTokens: request.window.candidates.map((candidate) => candidate.token),
    });
  },
};
