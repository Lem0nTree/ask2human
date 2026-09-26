import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

const serverOnlyLoader = `
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { url: 'data:text/javascript,export%20%7B%7D', shortCircuit: true };
    return nextResolve(specifier, context);
  }
`;
register(`data:text/javascript,${encodeURIComponent(serverOnlyLoader)}`, import.meta.url);

test('t2000 rejection split is the buyer share with seller remainder and floor semantics', async () => {
  const { sellerGrossForRejection } = await import('../app/lib/server/payments.ts');
  assert.equal(sellerGrossForRejection('1000000', 7500), '250000');
  assert.equal(sellerGrossForRejection('101', 2500), '76');
  assert.equal(sellerGrossForRejection('101', 10000), '0');
  assert.throws(() => sellerGrossForRejection('100', 10001), /rejection split is invalid/);
});
