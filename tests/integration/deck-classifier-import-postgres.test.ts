import { Client } from 'pg';
import { stringify } from 'yaml';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DeckClassifierAdminService } from '../../src/server/services/deck-classifier-admin-service';
import { buildRankedDeckObservation } from '../../src/server/services/ranked-deck-observation-service';

const mocks = vi.hoisted(() => ({ connect: vi.fn(), query: vi.fn() }));
vi.mock('../../src/server/db/pool.js', () => ({
  pool: { connect: mocks.connect, query: mocks.query },
}));

// Only transaction-local temporary tables are written. Uses migrated local column types/checks.
describe.skipIf(process.env.RUN_LOCAL_POSTGRES !== '1')('仅排位样板导入 PostgreSQL 约束', () => {
  const client = new Client({
    host: '127.0.0.1',
    port: 5432,
    database: 'loveca',
    user: 'loveca',
    password: 'loveca_dev',
    connectionTimeoutMillis: 5000,
  });
  const service = new DeckClassifierAdminService();
  const userId = '11111111-1111-4111-8111-111111111111';
  const archetypeId = '22222222-2222-4222-8222-222222222222';
  const operator = {
    actorUserId: userId,
    actorRole: 'admin' as const,
    requestId: 'postgres-regression',
  };
  const mainDeck: string[] = [];
  const cardSummaries: Record<string, unknown> = {};
  for (let i = 1; i <= 15; i++) {
    const code = `PL!N-bp1-${String(i).padStart(3, '0')}-N`;
    mainDeck.push(code, code, code, code);
    cardSummaries[code] = {
      cardCode: code,
      name: `卡牌${i}`,
      cardType: i <= 12 ? 'MEMBER' : 'LIVE',
    };
  }
  const normalized = buildRankedDeckObservation({
    mainDeck,
    cardSummaries,
    seasonId: 'test-season',
    matchId: 'RANKED',
    seat: 'FIRST',
    userId,
    observedAt: new Date(),
  });
  const input = (matchId: string, expectedDraftRevision: number) => ({
    archetypeId,
    matchId,
    seat: 'FIRST' as const,
    name: '测试导入',
    sourceNote: '测试',
    reason: '本地回归验证',
    expectedDraftRevision,
  });

  beforeAll(async () => {
    await client.connect();
    mocks.query.mockImplementation((sql: string, values?: unknown[]) => client.query(sql, values));
    await client.query('BEGIN');
    for (const table of [
      'match_records',
      'match_participants',
      'match_deck_snapshots',
      'ranked_deck_observations',
      'deck_archetypes',
      'deck_classifier_settings',
      'cards',
    ]) {
      await client.query(
        `CREATE TEMP TABLE ${table} ON COMMIT DROP AS SELECT * FROM public.${table} WITH NO DATA`
      );
    }
    for (const table of ['deck_archetype_templates', 'management_audit_logs']) {
      await client.query(
        `CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL) ON COMMIT DROP`
      );
    }
    await client.query('ALTER TABLE match_participants ADD UNIQUE (match_id, seat)');
    await client.query('ALTER TABLE ranked_deck_observations ADD UNIQUE (match_id, seat)');
    await client.query(`ALTER TABLE deck_archetype_templates ADD CONSTRAINT deck_archetype_templates_source_observation_fk
      FOREIGN KEY (source_match_id, source_seat) REFERENCES ranked_deck_observations (match_id, seat) ON DELETE SET NULL`);
    await client.query(`INSERT INTO deck_archetypes (id, lifecycle) VALUES ($1, 'ACTIVE')`, [
      archetypeId,
    ]);
    await client.query('INSERT INTO deck_classifier_settings (id, draft_revision) VALUES (1, 7)');
    for (const card of normalized.mainDeckCards) {
      await client.query('INSERT INTO cards (card_code, card_type) VALUES ($1, $2)', [
        card.baseCardCode,
        card.cardType,
      ]);
    }
    for (const mode of ['RANKED', 'PUBLIC_TABLE', 'ONLINE_ROOM', 'SOLITAIRE']) {
      await client.query(
        `INSERT INTO match_records (match_id, origin_kind, status, completeness, ended_at, sealed_at)
        VALUES ($1, $1, 'INTERRUPTED', $2, now(), now())`,
        [mode, mode === 'RANKED' ? 'METADATA_ONLY' : 'PARTIAL']
      );
      await client.query(
        `INSERT INTO match_participants (match_id, seat, user_id, participant_kind)
        VALUES ($1, 'FIRST', $2, 'USER')`,
        [mode, userId]
      );
      await client.query(
        `INSERT INTO match_deck_snapshots (match_id, seat, user_id, validation_state, main_deck, card_summaries)
        VALUES ($1, 'FIRST', $2, 'RUNTIME_ACCEPTED', $3, $4)`,
        [mode, userId, JSON.stringify(mainDeck), JSON.stringify(cardSummaries)]
      );
    }
    await client.query(
      `INSERT INTO ranked_deck_observations (match_id, seat, user_id, deck_fingerprint, main_deck_cards)
      VALUES ('RANKED', 'FIRST', $1, $2, $3)`,
      [userId, normalized.deckFingerprint, JSON.stringify(normalized.mainDeckCards)]
    );
    mocks.connect.mockResolvedValue({
      async query(sql: string, values?: unknown[]) {
        // Preserve service transaction behavior without committing the outer fixture transaction.
        const statement =
          sql === 'BEGIN'
            ? 'SAVEPOINT import_operation'
            : sql === 'COMMIT'
              ? 'RELEASE SAVEPOINT import_operation'
              : sql === 'ROLLBACK'
                ? 'ROLLBACK TO SAVEPOINT import_operation'
                : sql;
        return client.query(statement, values);
      },
      release() {},
    });
  });

  afterAll(async () => {
    try {
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  });

  it('拒绝非排位手动导入，在原排位外键下导入长期记录并保留卡表', async () => {
    for (const mode of ['PUBLIC_TABLE', 'ONLINE_ROOM', 'SOLITAIRE']) {
      await expect(service.createTemplateFromMatch(input(mode, 7), operator)).rejects.toMatchObject(
        { code: 'DECK_TEMPLATE_ORIGIN_UNSUPPORTED' }
      );
    }
    expect(
      (
        await client.query<{ draft_revision: number }>(
          'SELECT draft_revision FROM deck_classifier_settings'
        )
      ).rows[0].draft_revision
    ).toBe(7);
    expect((await client.query('SELECT * FROM deck_archetype_templates')).rowCount).toBe(0);
    expect((await client.query('SELECT * FROM management_audit_logs')).rowCount).toBe(0);
    await client.query('SAVEPOINT missing_observation');
    await client.query('DELETE FROM ranked_deck_observations');
    await expect(
      service.createTemplateFromMatch(input('RANKED', 7), operator)
    ).rejects.toMatchObject({ code: 'DECK_OBSERVATION_NOT_FOUND' });
    await client.query('ROLLBACK TO SAVEPOINT missing_observation');
    // A purged replay has no snapshot, but its long-lived ranked observation remains importable.
    await client.query("DELETE FROM match_deck_snapshots WHERE match_id = 'RANKED'");
    const result = await service.createTemplateFromMatch(input('RANKED', 7), operator);
    expect(result.sourceMatchId).toBe('RANKED');
    expect(result.sourceSeat).toBe('FIRST');
    expect(result.cards.reduce((sum, card) => sum + card.count, 0)).toBe(60);
    expect((await client.query('SELECT * FROM management_audit_logs')).rowCount).toBe(1);
    await client.query('SAVEPOINT invalid_source');
    await expect(
      client.query("UPDATE deck_archetype_templates SET source_match_id = 'SOLITAIRE'")
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'deck_archetype_templates_source_observation_fk',
    });
    await client.query('ROLLBACK TO SAVEPOINT invalid_source');
    await client.query('DELETE FROM ranked_deck_observations');
    const templates = (
      await client.query<{
        source_match_id: string | null;
        source_seat: string | null;
        cards: unknown[];
      }>('SELECT source_match_id, source_seat, cards FROM deck_archetype_templates')
    ).rows;
    expect(templates).toHaveLength(1);
    expect(templates[0]).toMatchObject({ source_match_id: null, source_seat: null });
    expect(templates[0].cards).toHaveLength(15);
  });
  it('YAML 预览只读，确认写入 MANUAL 样板并验证重复、卡库和草稿冲突', async () => {
    await client.query('SAVEPOINT yaml_test');
    try {
      await client.query('DELETE FROM deck_archetype_templates');
      await client.query('DELETE FROM management_audit_logs');
      await client.query('UPDATE deck_classifier_settings SET draft_revision = 7');
      const main_deck = {
        members: normalized.mainDeckCards
          .filter((c) => c.cardType === 'MEMBER')
          .map((c) => ({ card_code: c.cardCode, count: c.count })),
        lives: normalized.mainDeckCards
          .filter((c) => c.cardType === 'LIVE')
          .map((c) => ({ card_code: c.cardCode, count: c.count })),
      };
      const yamlContent = stringify({ player_name: '文件卡组', main_deck, energy_deck: [] });
      const preview = await service.previewTemplateYaml(yamlContent);
      expect(preview).toMatchObject({
        memberTotal: 48,
        liveTotal: 12,
        existingTemplate: null,
        deckFingerprint: normalized.deckFingerprint,
      });
      expect((await client.query('SELECT * FROM deck_archetype_templates')).rowCount).toBe(0);
      expect((await client.query('SELECT * FROM management_audit_logs')).rowCount).toBe(0);
      const payload = {
        expectedDraftRevision: 7,
        archetypeId,
        yamlContent,
        name: '文件样板',
        sourceNote: 'YAML 文件：test.yaml',
        reason: '管理员确认导入',
      };
      await expect(
        service.createTemplateFromYaml(
          {
            ...payload,
            yamlContent: yamlContent.replace(main_deck.members[0].card_code, 'NOT-A-CARD'),
          },
          operator
        )
      ).rejects.toMatchObject({ code: 'DECK_TEMPLATE_CARD_INVALID' });
      await client.query("UPDATE cards SET card_type='LIVE' WHERE card_code=$1", [
        normalized.mainDeckCards[0].baseCardCode,
      ]);
      await expect(service.previewTemplateYaml(yamlContent)).rejects.toMatchObject({
        code: 'DECK_TEMPLATE_CARD_INVALID',
      });
      await client.query("UPDATE cards SET card_type='MEMBER' WHERE card_code=$1", [
        normalized.mainDeckCards[0].baseCardCode,
      ]);
      const result = await service.createTemplateFromYaml(payload, operator);
      expect(result).toMatchObject({
        sourceKind: 'MANUAL',
        sourceMatchId: null,
        sourceSeat: null,
        name: '文件样板',
        sourceNote: payload.sourceNote,
      });
      expect(result.cards).toEqual(preview.cards);
      expect((await client.query('SELECT * FROM management_audit_logs')).rowCount).toBe(1);
      expect((await service.previewTemplateYaml(yamlContent)).existingTemplate?.id).toBe(result.id);
      await expect(service.createTemplateFromYaml(payload, operator)).rejects.toMatchObject({
        code: 'DECK_CLASSIFIER_DRAFT_REVISION_CONFLICT',
      });
      await expect(
        service.createTemplateFromYaml({ ...payload, expectedDraftRevision: 8 }, operator)
      ).rejects.toMatchObject({ code: 'DECK_TEMPLATE_ALREADY_EXISTS' });
      expect(
        (
          await client.query<{ draft_revision: number }>(
            'SELECT draft_revision FROM deck_classifier_settings'
          )
        ).rows[0].draft_revision
      ).toBe(8);
      expect((await client.query('SELECT * FROM deck_archetype_templates')).rowCount).toBe(1);
      await client.query('UPDATE deck_archetype_templates SET enabled=false');
      expect((await service.previewTemplateYaml(yamlContent)).existingTemplate?.enabled).toBe(
        false
      );
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT yaml_test');
    }
  });
});
