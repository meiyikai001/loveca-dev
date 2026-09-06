import { Client, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MatchReplayReadService } from '../../src/server/services/match-replay-read-service';

vi.mock('../../src/server/db/pool.js', () => ({ pool: { query: vi.fn() } }));

// Run with RUN_LOCAL_POSTGRES=1 after starting the local test environment.
// Only temporary tables are written; existing records are never read or changed.
describe.skipIf(process.env.RUN_LOCAL_POSTGRES !== '1')('样板候选 PostgreSQL 查询', () => {
  const client = new Client({
    host: '127.0.0.1',
    port: 5432,
    database: 'loveca',
    user: 'loveca',
    password: 'loveca_dev',
    connectionTimeoutMillis: 5000,
  });
  const firstUser = '11111111-1111-4111-8111-111111111111';
  const secondUser = '22222222-2222-4222-8222-222222222222';
  const seasonId = '33333333-3333-4333-8333-333333333333';
  const service = new MatchReplayReadService({
    queryClient: {
      async query<T>(sql: string, values?: readonly unknown[]) {
        const result = await client.query<T & QueryResultRow>(
          sql,
          values ? [...values] : undefined
        );
        return { rows: result.rows };
      },
    },
  });

  beforeAll(async () => {
    await client.connect();
    await client.query('BEGIN');
    // Copy column types from the migrated schema, retaining UUID versus text differences.
    for (const table of [
      'match_records',
      'match_participants',
      'match_deck_snapshots',
      'ranked_deck_observations',
      'ranked_matches',
      'ranked_seasons',
      'theme_table_assignments',
      'theme_table_versions',
    ]) {
      await client.query(
        `CREATE TEMP TABLE ${table} ON COMMIT DROP AS SELECT * FROM public.${table} WITH NO DATA`
      );
    }
    for (const [index, origin] of [
      'RANKED',
      'PUBLIC_TABLE',
      'ONLINE_ROOM',
      'SOLITAIRE',
    ].entries()) {
      await client.query(
        `INSERT INTO match_records
        (match_id, origin_kind, status, completeness, started_at, ended_at, sealed_at,
         replay_capabilities, replay_limitations)
        VALUES ($1, $1, 'COMPLETED', $2, $3, $3, $3, '[]', '[]')`,
        [
          origin,
          origin === 'RANKED' ? 'METADATA_ONLY' : 'FULL',
          new Date(1700000000000 + index * 1000),
        ]
      );
      for (const [seat, user, kind, name] of [
        ['FIRST', firstUser, 'USER', '玩家甲'],
        [
          'SECOND',
          origin === 'SOLITAIRE' ? 'system:solitaire' : secondUser,
          origin === 'SOLITAIRE' ? 'SYSTEM' : 'USER',
          '玩家乙',
        ],
      ]) {
        await client.query(
          `INSERT INTO match_participants
          (match_id, seat, user_id, participant_kind, display_name, player_id)
          VALUES ($1, $2, $3, $4, $5, $2)`,
          [origin, seat, user, kind, name]
        );
        await client.query(
          `INSERT INTO match_deck_snapshots
          (match_id, seat, user_id, source_deck_name, main_deck, card_summaries, validation_state)
          VALUES ($1, $2, $3, $4, $5, $6, 'VALID')`,
          [
            origin,
            seat,
            user,
            `${name}的卡组`,
            JSON.stringify(origin === 'RANKED' ? [] : Array(60).fill('test-card')),
            JSON.stringify(origin === 'RANKED' ? {} : { 'test-card': { cardType: 'MEMBER' } }),
          ]
        );
      }
    }
    await client.query(
      `INSERT INTO ranked_deck_observations (match_id, seat, user_id)
      VALUES ('RANKED', 'FIRST', $1), ('RANKED', 'SECOND', $1)`,
      [firstUser]
    );
    await client.query(`INSERT INTO ranked_matches (match_id, season_id) VALUES ('RANKED', $1)`, [
      seasonId,
    ]);
    await client.query(`INSERT INTO ranked_seasons (id, name) VALUES ($1, '测试赛季')`, [seasonId]);
  });

  afterAll(async () => {
    try {
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  });

  it('仅展示排位，正确匹配 UUID 观察与文本玩家 ID，并排除其他模式', async () => {
    const page = await service.listTemplateMatchCandidates();
    expect(page.items.map((item) => [item.matchId, item.importableSeats])).toEqual([
      ['RANKED', ['FIRST']],
    ]);
    expect(page.items[0].deckNamesBySeat).toEqual({
      FIRST: '玩家甲的卡组',
      SECOND: '玩家乙的卡组',
    });
    expect(page.items[0].activityName).toBe('测试赛季');
  });

  it('赛季、双方玩家和日期组合筛选执行真实 SQL', async () => {
    const page = await service.listTemplateMatchCandidates({
      rankedSeasonId: seasonId,
      playerAQuery: '玩家乙',
      playerBQuery: firstUser,
      startedFrom: 1699999999999,
      startedTo: 1700000000001,
    });
    expect(page.items.map((item) => item.matchId)).toEqual(['RANKED']);
    const empty = await service.listTemplateMatchCandidates({
      playerAQuery: firstUser,
      playerBQuery: firstUser,
    });
    expect(empty.items).toEqual([]);
  });

  it('分页不计入非排位记录', async () => {
    const first = await service.listTemplateMatchCandidates({ limit: 1 });
    const last = await service.listTemplateMatchCandidates({ limit: 1, offset: 1 });
    expect(first.items.map((item) => item.matchId)).toEqual(['RANKED']);
    expect(first.hasMore).toBe(false);
    expect(last.items).toEqual([]);
    expect(last.hasMore).toBe(false);
  });
});
