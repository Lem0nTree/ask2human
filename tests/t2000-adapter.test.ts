import assert from 'node:assert/strict';
import test from 'node:test';
import {
  atomicToUsdc,
  normalizeT2000Hash,
  t2000Config,
  T2000_COIN_TYPE,
  T2000_DEFAULT_PACKAGE_ID,
  T2000_LATEST_PACKAGE_ID,
} from '../app/lib/sui/t2000.ts';

test('t2000 adapter preserves integer USDC values and canonical hashes', () => {
  assert.equal(atomicToUsdc('10000'), 0.01);
  assert.equal(atomicToUsdc('100000'), 0.1);
  assert.equal(atomicToUsdc('1234567'), 1.234567);
  assert.equal(normalizeT2000Hash(`0x${'AB'.repeat(32)}`), `0x${'ab'.repeat(32)}`);
  assert.throws(() => atomicToUsdc('0'), /outside the allowed u64 range/);
  assert.throws(() => normalizeT2000Hash('0x1234'), /exactly 32 bytes/);
});

test('t2000 configuration fails closed for testnet and uses canonical mainnet USDC', () => {
  const previous = process.env.SUI_NETWORK;
  try {
    process.env.SUI_NETWORK = 'testnet';
    assert.throws(() => t2000Config(), /SUI_NETWORK=mainnet/);
    process.env.SUI_NETWORK = 'mainnet';
    const config = t2000Config();
    assert.equal(config.network, 'mainnet');
    assert.equal(config.asset, 'USDC');
    assert.equal(config.decimals, 6);
    assert.equal(config.coinType, T2000_COIN_TYPE);
  } finally {
    if (previous === undefined) delete process.env.SUI_NETWORK;
    else process.env.SUI_NETWORK = previous;
  }
});

test('t2000 keeps the immutable Job package and separates it from the latest call target', () => {
  assert.equal(T2000_DEFAULT_PACKAGE_ID, '0x358a819c1c016e2cc84ef5fbea81cba90c31f7f8a62bf45cb5e5276acf198bdd');
  assert.equal(T2000_LATEST_PACKAGE_ID, '0x818cfc9cb050ab034ad8fc2979be0d7d4ef3b48e8855621450e88095816d9cac');
  assert.notEqual(T2000_DEFAULT_PACKAGE_ID, T2000_LATEST_PACKAGE_ID);
});
