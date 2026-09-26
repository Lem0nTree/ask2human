import { createHash } from 'node:crypto';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import {
  buildCreateAndFundTx,
  buildRefundTx,
  buildReleaseTx,
  buildSubmitTx,
  createSuiTestnetClient,
  resolveEscrowTxForSigning,
  validateEscrowReceipt,
} from '../app/lib/sui/escrow.ts';
import {
  assertSuiTestnet,
  executeFrozenTransaction,
  loadDevelopmentKeypair,
} from './sui-testnet-common.ts';

const packageId = process.env.SUI_ESCROW_PACKAGE_ID ?? process.argv[2];
if (!packageId) {
  throw new Error('Pass the published testnet package ID as an argument or SUI_ESCROW_PACKAGE_ID');
}

const client: SuiGrpcClient = createSuiTestnetClient();
await assertSuiTestnet(client);
const owner = loadDevelopmentKeypair('owner');
const worker = loadDevelopmentKeypair('worker');
const ownerAddress = owner.toSuiAddress();
const workerAddress = worker.toSuiAddress();
if (ownerAddress === workerAddress) {
  throw new Error('Development owner and worker keys must be independent');
}
console.log('Independent owner and worker wallet check: true');

const MIN_WORKER_MIST = 50_000_000n;
let workerBalance = BigInt((await client.getBalance({ owner: workerAddress, coinType: '0x2::sui::SUI' })).balance.balance);
if (workerBalance < MIN_WORKER_MIST) {
  console.log('Transferring testnet gas from the owner to the worker wallet.');
}

if (workerBalance < MIN_WORKER_MIST) {
  const ownerBalance = BigInt((await client.getBalance({ owner: ownerAddress, coinType: '0x2::sui::SUI' })).balance.balance);
  if (ownerBalance < MIN_WORKER_MIST + 20_000_000n) {
    throw new Error('Insufficient Sui testnet balance to fund the worker wallet and its gas');
  }
  const fundWorker = new Transaction();
  const [workerGas] = fundWorker.splitCoins(fundWorker.gas, [MIN_WORKER_MIST]);
  fundWorker.transferObjects([workerGas], fundWorker.pure.address(workerAddress));
  const frozenFunding = await resolveEscrowTxForSigning(fundWorker, { sender: ownerAddress, client });
  await executeFrozenTransaction(client, owner, frozenFunding);
  workerBalance = BigInt((await client.getBalance({ owner: workerAddress, coinType: '0x2::sui::SUI' })).balance.balance);
}
if (workerBalance < MIN_WORKER_MIST) {
  throw new Error('Worker wallet did not receive enough Sui testnet gas');
}

const amountMist = '10000000';
const deadlineMs = String(Date.now() + 15 * 60 * 1000);
const briefHash = createHash('sha256').update('AskToHuman testnet escrow trial brief').digest();
const create = buildCreateAndFundTx({ packageId, worker: workerAddress, briefHash, deadlineMs, amountMist });
const frozenCreate = await resolveEscrowTxForSigning(create, { sender: ownerAddress, client });
const createdDigest = await executeFrozenTransaction(client, owner, frozenCreate);
const created = await validateEscrowReceipt({
  packageId,
  digest: createdDigest,
  expectedKind: 'created',
  expectedActor: ownerAddress,
}, client);
if (created.worker !== workerAddress || created.amountMist !== amountMist || created.deadlineMs !== deadlineMs) {
  throw new Error('Created event did not match the testnet trial terms');
}

const commitmentHash = createHash('sha256').update('AskToHuman testnet escrow trial completion').digest();
const submit = buildSubmitTx({ packageId, jobId: created.jobId, commitmentHash });
const frozenSubmit = await resolveEscrowTxForSigning(submit, { sender: workerAddress, client });
const submittedDigest = await executeFrozenTransaction(client, worker, frozenSubmit);
const submitted = await validateEscrowReceipt({
  packageId,
  digest: submittedDigest,
  expectedKind: 'submitted',
  expectedActor: workerAddress,
}, client);
if (submitted.jobId !== created.jobId || submitted.commitmentHash !== `0x${commitmentHash.toString('hex')}`) {
  throw new Error('Submission event did not match the testnet trial commitment');
}

const release = buildReleaseTx({ packageId, jobId: created.jobId });
const frozenRelease = await resolveEscrowTxForSigning(release, { sender: ownerAddress, client });
const releasedDigest = await executeFrozenTransaction(client, owner, frozenRelease);
const released = await validateEscrowReceipt({
  packageId,
  digest: releasedDigest,
  expectedKind: 'released',
  expectedActor: ownerAddress,
}, client);
if (released.jobId !== created.jobId || released.amountMist !== amountMist || released.worker !== workerAddress) {
  throw new Error('Release event did not match the created escrow terms');
}

const refundAmountMist = '5000000';
const refundDeadlineMs = Date.now() + 15_000;
const refundBriefHash = createHash('sha256').update('AskToHuman testnet refund trial brief').digest();
const refundJobTx = buildCreateAndFundTx({
  packageId,
  worker: workerAddress,
  briefHash: refundBriefHash,
  deadlineMs: String(refundDeadlineMs),
  amountMist: refundAmountMist,
});
const frozenRefundJob = await resolveEscrowTxForSigning(refundJobTx, { sender: ownerAddress, client });
const refundJobDigest = await executeFrozenTransaction(client, owner, frozenRefundJob);
const refundJob = await validateEscrowReceipt({
  packageId,
  digest: refundJobDigest,
  expectedKind: 'created',
  expectedActor: ownerAddress,
}, client);
if (refundJob.worker !== workerAddress || refundJob.amountMist !== refundAmountMist) {
  throw new Error('Refund trial creation did not match the fixed worker and amount');
}

const remainingMs = refundDeadlineMs - Date.now() + 5_000;
if (remainingMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, remainingMs));
}
const refundTx = buildRefundTx({ packageId, jobId: refundJob.jobId });
const frozenRefund = await resolveEscrowTxForSigning(refundTx, { sender: ownerAddress, client });
const refundedDigest = await executeFrozenTransaction(client, owner, frozenRefund);
const refunded = await validateEscrowReceipt({
  packageId,
  digest: refundedDigest,
  expectedKind: 'refunded',
  expectedActor: ownerAddress,
}, client);
if (refunded.jobId !== refundJob.jobId || refunded.amountMist !== refundAmountMist || refunded.worker !== workerAddress) {
  throw new Error('Refund event did not match the expired, unsubmitted escrow');
}

console.log(`Sui testnet package ID: ${packageId}`);
console.log(`Owner address: ${ownerAddress}`);
console.log(`Worker address: ${workerAddress}`);
console.log(`Job object ID: ${created.jobId}`);
console.log(`Escrow amount (MIST): ${amountMist}`);
console.log(`Create digest: ${createdDigest}`);
console.log(`Submit digest: ${submittedDigest}`);
console.log(`Release digest: ${releasedDigest}`);
console.log(`Refund trial job object ID: ${refundJob.jobId}`);
console.log(`Refund trial create digest: ${refundJobDigest}`);
console.log(`Refund digest: ${refundedDigest}`);
console.log('Finalized create, worker submission, owner release, and expired unsubmitted refund receipts validated on Sui testnet.');
