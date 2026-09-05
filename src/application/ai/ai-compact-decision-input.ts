import type {
  AiCardObservationV1,
  AiCardObservationV2,
  AiDecisionRequestV2,
} from './ai-decision-contract.js';

export interface AiCompactCardReference {
  /** 只引用本次输入的 cardCatalog，不是卡牌实例标识或可提交的动作 token。 */
  readonly cardRef: string;
}

export type AiCompactDecisionValue<T> = T extends AiCardObservationV1
  ? AiCompactCardReference
  : T extends object
    ? { readonly [K in keyof T]: AiCompactDecisionValue<T[K]> }
    : T;

export interface AiCompactDecisionInput {
  readonly format: 'loveca-ai-compact-v1';
  /** 完整可见卡面快照；同卡号的不同修正快照不会合并。 */
  readonly cardCatalog: Readonly<Record<string, AiCardObservationV2>>;
  readonly request: AiCompactDecisionValue<AiDecisionRequestV2>;
}

/**
 * 仅压缩已经脱敏的协议请求，不是新的可见性投影或安全过滤器。
 * 保留所有候选、次序、token、卡文及数值；只去重完整卡面快照，不访问权威状态。
 * 目录在每次调用时重新建立，不携带上一决策或另一席位的信息。
 */
export function compactAiDecisionRequest(request: AiDecisionRequestV2): AiCompactDecisionInput {
  const cardCatalog: Record<string, AiCardObservationV2> = {};
  const cardRefBySnapshot = new Map<string, string>();

  function compact(value: unknown): unknown {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(compact);

    if (isCardObservation(value)) {
      const snapshotKey = JSON.stringify(value);
      let cardRef = cardRefBySnapshot.get(snapshotKey);
      if (!cardRef) {
        cardRef = `c${cardRefBySnapshot.size + 1}`;
        cardRefBySnapshot.set(snapshotKey, cardRef);
        cardCatalog[cardRef] = globalThis.structuredClone(value);
      }
      return { cardRef };
    }

    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, compact(entry)]));
  }

  return {
    format: 'loveca-ai-compact-v1',
    cardCatalog,
    request: compact(request) as AiCompactDecisionValue<AiDecisionRequestV2>,
  };
}

function isCardObservation(value: object): value is AiCardObservationV2 {
  return (
    'cardCode' in value &&
    typeof value.cardCode === 'string' &&
    'cardType' in value &&
    typeof value.cardType === 'string'
  );
}
