import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface IndexedExportCard {
  readonly cardCode: string;
  readonly rare: string;
  readonly baseCardCode: string;
  readonly raw: Record<string, unknown>;
}

export interface ExportEffectCard {
  readonly cardCode: string;
  readonly cardType: 'MEMBER' | 'LIVE';
  readonly name: string;
  readonly stat: number;
  readonly effectText: string;
}

export interface ExportCardGroup {
  readonly baseCardCode: string;
  readonly prints: readonly ExportEffectCard[];
  readonly representative: ExportEffectCard;
}

export function normalizeExportCardCode(value: string): string {
  return value.trim().replaceAll('＋', '+');
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function indexExportCards(payload: unknown): IndexedExportCard[] {
  if (!Array.isArray(payload)) throw new Error('导出 JSON 顶层必须为卡牌数组。');
  return payload.map((value: unknown, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`导出 JSON 第 ${index + 1} 条记录必须为卡牌对象。`);
    }
    const raw = value as Record<string, unknown>;
    const code = nonemptyString(raw.cardCode);
    if (!code) throw new Error(`导出 JSON 第 ${index + 1} 条记录缺少 cardCode。`);
    const cardCode = normalizeExportCardCode(code);
    const rare = normalizeExportCardCode(nonemptyString(raw.rare) ?? '');
    // 编号末段为罕度；先建立索引，选中后再校验 rare，避免无关卡牌错误阻断本批。
    const baseCardCode = cardCode.replace(/-[^-]+$/, '');
    return { cardCode, rare, baseCardCode, raw };
  });
}

function validateEffectCard(card: IndexedExportCard): ExportEffectCard {
  const { cardCode, rare, baseCardCode, raw } = card;
  if (!rare || !baseCardCode || cardCode !== `${baseCardCode}-${rare}`) {
    throw new Error(`${cardCode} 的 rare 缺失或与卡号后缀不一致。`);
  }
  const cardType = raw.cardType;
  if (cardType !== 'MEMBER' && cardType !== 'LIVE') {
    throw new Error(
      `${cardCode} 的 cardType 必须为 MEMBER 或 LIVE，当前为 ${JSON.stringify(cardType)}。`
    );
  }
  const name = nonemptyString(raw.nameCn);
  if (!name) throw new Error(`${cardCode} 缺少 nameCn，无法生成中文卡名。`);
  const statField = cardType === 'MEMBER' ? 'cost' : 'score';
  const stat = raw[statField];
  if (typeof stat !== 'number' || !Number.isSafeInteger(stat) || stat < 0) {
    throw new Error(`${cardCode} 的 ${statField} 必须为非负整数，当前为 ${JSON.stringify(stat)}。`);
  }
  const effectText = nonemptyString(raw.cardTextCn)?.replace(/\r\n?/g, '\n');
  if (!effectText || /^[-ー－—]+$/.test(effectText)) {
    throw new Error(`${cardCode} 缺少可用的 cardTextCn；不以日文卡文或其他来源兜底。`);
  }
  return { cardCode, cardType, name, stat, effectText };
}

export function selectExportCardGroups(
  payload: unknown,
  scopes: readonly string[]
): ExportCardGroup[] {
  if (scopes.length === 0) throw new Error('请至少提供一个基础编号、完整卡号或卡号前缀。');
  const cards = indexExportCards(payload);
  const groups = new Map<string, IndexedExportCard[]>();
  const printToBase = new Map<string, string>();
  for (const card of cards) {
    const prints = groups.get(card.baseCardCode) ?? [];
    prints.push(card);
    groups.set(card.baseCardCode, prints);
    printToBase.set(card.cardCode, card.baseCardCode);
  }
  const selected = new Set<string>();
  for (const rawScope of scopes) {
    const scope = normalizeExportCardCode(rawScope);
    if (!scope) throw new Error('卡牌范围不能为空。');
    const exactBase = groups.has(scope) ? scope : printToBase.get(scope);
    const matches = exactBase
      ? [exactBase]
      : [...groups.keys()].filter((code) => code.startsWith(scope));
    if (matches.length === 0) throw new Error(`${rawScope} 在导出 JSON 中没有匹配卡牌。`);
    for (const code of matches) selected.add(code);
  }
  return [...selected]
    .sort((a, b) => a.localeCompare(b, 'en'))
    .map((baseCardCode) => {
      const prints = groups
        .get(baseCardCode)!
        .map(validateEffectCard)
        .sort((a, b) => a.cardCode.localeCompare(b.cardCode, 'en'));
      const seen = new Set<string>();
      for (const card of prints) {
        if (seen.has(card.cardCode)) throw new Error(`${card.cardCode} 在导出 JSON 中重复登记。`);
        seen.add(card.cardCode);
      }
      const representative = prints[0]!;
      for (const [field, label] of [
        ['cardType', 'cardType'],
        ['name', 'nameCn'],
        ['stat', '费用/分数'],
        ['effectText', 'cardTextCn'],
      ] as const) {
        if (prints.some((card) => card[field] !== representative[field])) {
          const details = prints
            .map((card) => `${card.cardCode}=${JSON.stringify(card[field])}`)
            .join('；');
          throw new Error(`${baseCardCode} 的不同罕度存在 ${label} 冲突，拒绝自动合并：${details}`);
        }
      }
      return { baseCardCode, prints, representative };
    });
}

export function loadExportCardGroups(
  cardsJsonPath: string,
  scopes: readonly string[]
): ExportCardGroup[] {
  const path = resolve(cardsJsonPath);
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `读取导出 JSON 失败：${path}；${error instanceof Error ? error.message : String(error)}`
    );
  }
  return selectExportCardGroups(payload, scopes);
}
