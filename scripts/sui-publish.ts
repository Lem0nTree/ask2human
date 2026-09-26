import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Transaction } from '@mysten/sui/transactions';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import {
  assertSuiTestnet,
  executeFrozenTransaction,
  loadDevelopmentKeypair,
} from './sui-testnet-common.ts';

const client = new SuiGrpcClient({
  network: 'testnet',
  baseUrl: process.env.SUI_RPC_URL ?? 'https://fullnode.testnet.sui.io:443',
});

await assertSuiTestnet(client);
const owner = loadDevelopmentKeypair('owner');
const ownerAddress = owner.toSuiAddress();
const ownerBalance = BigInt((await client.getBalance({ owner: ownerAddress, coinType: '0x2::sui::SUI' })).balance.balance);
if (ownerBalance < 500_000_000n) {
  throw new Error(`Owner needs at least 500000000 MIST in Sui testnet funds before publish; current balance is ${ownerBalance}`);
}
console.log(`Owner testnet balance available: ${ownerBalance} MIST.`);

const modulePath = fileURLToPath(new URL('../contracts/sui_escrow/build/ask2human_escrow/bytecode_modules/job_escrow.mv', import.meta.url));
const moduleBytes = new Uint8Array(readFileSync(modulePath));
const transaction = new Transaction();
const [upgradeCap] = transaction.publish({
  modules: [Array.from(moduleBytes)],
  dependencies: ['0x1', '0x2'],
});
transaction.transferObjects([upgradeCap], transaction.pure.address(ownerAddress));
transaction.setSender(ownerAddress);
const bytes = await transaction.build({ client });
if (!transaction.isFullyResolved()) {
  throw new Error('Sui SDK did not fully resolve package publication transaction');
}
const digest = await transaction.getDigest();
const frozen = {
  digest,
  transactionBytesBase64: Buffer.from(bytes).toString('base64'),
  transactionJson: await transaction.toJSON(),
};
const publishDigest = await executeFrozenTransaction(client, owner, frozen);
const published = await client.waitForTransaction({
  digest: publishDigest,
  include: { transaction: true, effects: true },
});
if (published.$kind !== 'Transaction' || !published.Transaction.effects?.status?.success) {
  throw new Error('Sui testnet package publication did not finalize successfully');
}

const packageWrites = published.Transaction.effects.changedObjects.filter((changed) => {
  const state = String(changed.outputState).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return changed.objectId && (state === '3' || state.includes('PACKAGEWRITE'));
});
if (packageWrites.length !== 1 || !packageWrites[0].objectId) {
  throw new Error(`Expected one newly published package, found ${packageWrites.length}`);
}

console.log(`Sui testnet package ID: ${packageWrites[0].objectId}`);
console.log(`Publication digest: ${publishDigest}`);
console.log(`Owner address: ${ownerAddress}`);
