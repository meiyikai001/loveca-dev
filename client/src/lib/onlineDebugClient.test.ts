import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiPost: vi.fn(),
}));

vi.mock('@/lib/apiClient', () => ({
  apiClient: {
    post: mocks.apiPost,
  },
}));

import { executeOnlineDebugAiTurn } from './onlineDebugClient';

describe('executeOnlineDebugAiTurn', () => {
  beforeEach(() => {
    mocks.apiPost.mockReset();
  });

  it('posts the opponent seat to the encoded remote debug match endpoint', async () => {
    mocks.apiPost.mockResolvedValue({ data: { success: true }, error: null });

    await expect(executeOnlineDebugAiTurn('debug match/%', 'SECOND')).resolves.toEqual({
      success: true,
    });
    expect(mocks.apiPost).toHaveBeenCalledWith('/api/debug/matches/debug%20match%2F%25/ai-turn', {
      aiSeat: 'SECOND',
    });
  });

  it('surfaces a rejected AI step as an error', async () => {
    mocks.apiPost.mockResolvedValue({
      data: { success: false, error: '当前没有可执行的 AI 决策' },
      error: { code: 'AI_TURN_REJECTED', message: '备用错误' },
    });

    await expect(executeOnlineDebugAiTurn('match-1', 'FIRST')).rejects.toThrow(
      '当前没有可执行的 AI 决策'
    );
  });

  it('surfaces an API error when no result is returned', async () => {
    mocks.apiPost.mockResolvedValue({
      data: null,
      error: { code: 'AI_PROVIDER_ERROR', message: 'AI 决策服务不可用' },
    });

    await expect(executeOnlineDebugAiTurn('match-1', 'SECOND')).rejects.toThrow(
      'AI 决策服务不可用'
    );
  });
});
