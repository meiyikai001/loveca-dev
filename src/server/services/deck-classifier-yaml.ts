import { parseDocument } from 'yaml';
import { DeckConfigSchema } from '../../domain/card-data/deck-loader.js';
import {
  DECK_CLASSIFIER_YAML_MAX_BYTES,
  type DeckClassifierYamlPreviewView,
} from '../../online/deck-classifier-types.js';
import { normalizeDeck, fingerprintNormalizedDeck } from './deck-classifier-engine.js';

// A classifier template owns only the main deck; energy and other export fields are ignored.
const templateYamlSchema = DeckConfigSchema.pick({ player_name: true, main_deck: true });

export function parseClassifierYaml(
  content: string
): Omit<DeckClassifierYamlPreviewView, 'existingTemplate'> {
  if (!content.trim() || Buffer.byteLength(content, 'utf8') > DECK_CLASSIFIER_YAML_MAX_BYTES) {
    throw new Error('请选择非空且不超过 64 KB 的 YAML 文件');
  }
  const document = parseDocument(content, { uniqueKeys: true });
  if (document.errors.length || document.warnings.length)
    throw new Error('YAML 格式无效，请检查语法、重复字段或不支持的标签');
  const parsed = templateYamlSchema.safeParse(document.toJS({ maxAliasCount: 30 }));
  if (!parsed.success)
    throw new Error(`YAML 卡组结构无效：${parsed.error.issues[0]?.message ?? '缺少主卡组'}`);
  const normalized = normalizeDeck([
    ...parsed.data.main_deck.members.map((card) => ({
      cardCode: card.card_code,
      cardType: 'MEMBER' as const,
      count: card.count,
    })),
    ...parsed.data.main_deck.lives.map((card) => ({
      cardCode: card.card_code,
      cardType: 'LIVE' as const,
      count: card.count,
    })),
  ]);
  if (!normalized.valid)
    throw new Error(normalized.issues.map((issue) => issue.message).join('；'));
  return {
    suggestedName: parsed.data.player_name.trim().slice(0, 120),
    cards: [
      ...normalized.deck.members.map((card) => ({ ...card, cardType: 'MEMBER' as const })),
      ...normalized.deck.lives.map((card) => ({ ...card, cardType: 'LIVE' as const })),
    ],
    deckFingerprint: fingerprintNormalizedDeck(normalized.deck),
    memberTotal: normalized.deck.memberTotal,
    liveTotal: normalized.deck.liveTotal,
  };
}
