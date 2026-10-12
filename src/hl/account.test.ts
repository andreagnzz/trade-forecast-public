import { describe, expect, it, vi } from 'vitest';
import { subscribeAccount } from './account';

const { close } = vi.hoisted(() => ({ close: vi.fn() }));

vi.mock('@nktkas/hyperliquid', () => ({
  HttpTransport: vi.fn(),
  InfoClient: vi.fn(),
  WebSocketTransport: class {
    socket = { addEventListener: () => undefined };
    close = close;
  },
  SubscriptionClient: class {
    orderUpdates = () => Promise.resolve();
    userFills = () => Promise.reject(new Error('timeout'));
    clearinghouseState = () => Promise.resolve();
  },
}));

describe('subscribeAccount', () => {
  it('closes its socket when a subscription fails, so no handler outlives the error', async () => {
    const handlers = {
      onOrder: vi.fn(),
      onFills: vi.fn(),
      onPosition: vi.fn(),
      onConnection: vi.fn(),
    };
    await expect(
      subscribeAccount('0x0000000000000000000000000000000000000001', 'BTC', handlers),
    ).rejects.toThrow('timeout');
    expect(close).toHaveBeenCalledOnce();
  });
});
