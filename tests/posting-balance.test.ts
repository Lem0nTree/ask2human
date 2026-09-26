import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpError } from '../app/lib/server/errors';
import { assertSufficientPostingBalance } from '../app/lib/server/posting-balance';
import { T2000_COIN_TYPE } from '../app/lib/sui/t2000';

function errorCode(error: unknown): string | undefined {
  return error instanceof HttpError ? error.code : undefined;
}

test('posting balance uses the canonical USDC query and exact BigInt comparison', async () => {
  const owner = `0x${'ab'.repeat(32)}`;
  let request: { owner: string; coinType: string } | undefined;
  await assertSufficientPostingBalance(owner, '900719925474099300000', {
    readBalance: async ({ owner: requestedOwner, coinType }) => {
      request = { owner: requestedOwner, coinType };
      return { balance: { balance: '900719925474099300001', coinBalance: '0', addressBalance: '0' } };
    },
  });
  assert.deepEqual(request, { owner, coinType: T2000_COIN_TYPE });
});

test('posting balance rejects an insufficient wallet without changing state', async () => {
  await assert.rejects(
    assertSufficientPostingBalance('0xowner', 101n, {
      readBalance: async () => ({ balance: { balance: '100' } }),
    }),
    (error: unknown) => errorCode(error) === 'insufficient_owner_balance' && (error as HttpError).status === 409,
  );
});

test('posting balance fails closed for unavailable or malformed RPC responses', async () => {
  await assert.rejects(
    assertSufficientPostingBalance('0xowner', 1n, {
      readBalance: async () => { throw new Error('fullnode unavailable'); },
    }),
    (error: unknown) => errorCode(error) === 'owner_balance_unavailable' && (error as HttpError).status === 503,
  );
  await assert.rejects(
    assertSufficientPostingBalance('0xowner', 1n, {
      readBalance: async () => ({ balance: { balance: 1 } }),
    }),
    (error: unknown) => errorCode(error) === 'owner_balance_unavailable' && (error as HttpError).status === 503,
  );
});

test('posting balance timeout aborts the reader and clears its timer', async () => {
  let aborted = false;
  await assert.rejects(
    assertSufficientPostingBalance('0xowner', 1n, {
      timeoutMs: 5,
      readBalance: ({ signal }) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        }, { once: true });
      }),
    }),
    (error: unknown) => errorCode(error) === 'owner_balance_unavailable' && (error as HttpError).status === 503,
  );
  assert.equal(aborted, true);
});
