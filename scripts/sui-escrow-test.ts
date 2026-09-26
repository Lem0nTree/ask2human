import assert from 'node:assert/strict';
import { bcs } from '@mysten/sui/bcs';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import {
  buildCreateAndFundTx,
  buildRefundTx,
  buildReleaseTx,
  buildSubmitTx,
  validateEscrowReceipt,
} from '../app/lib/sui/escrow';

const packageId = `0x${'a'.repeat(64)}`;
const funder = `0x${'b'.repeat(64)}`;
const worker = `0x${'c'.repeat(64)}`;
const jobId = `0x${'d'.repeat(64)}`;
const digest = '11111111111111111111111111111111';
const briefHash = Uint8Array.from({ length: 32 }, (_, index) => index);
const commitmentHash = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);

function commandsFor(transaction: ReturnType<typeof buildCreateAndFundTx>) {
  return transaction.getData().commands;
}

const createTx = buildCreateAndFundTx({
  packageId,
  worker,
  briefHash,
  deadlineMs: '9000000000000',
  amountMist: '42000000',
});
assert.equal(commandsFor(createTx).length, 2);
assert.equal(commandsFor(createTx)[1].MoveCall?.function, 'create_and_fund');
assert.equal(commandsFor(buildSubmitTx({ packageId, jobId, commitmentHash }))[0].MoveCall?.function, 'submit');
assert.equal(commandsFor(buildReleaseTx({ packageId, jobId }))[0].MoveCall?.function, 'release');
assert.equal(commandsFor(buildRefundTx({ packageId, jobId }))[0].MoveCall?.function, 'refund');
assert.throws(() => buildCreateAndFundTx({ packageId, worker, briefHash, deadlineMs: '1', amountMist: '0' }));
assert.throws(() => buildSubmitTx({ packageId, jobId, commitmentHash: '0x12' }));
assert.throws(() => buildReleaseTx({ packageId, jobId: '0x1' }));

const createdEvent = bcs.struct('JobCreatedFixture', {
  job_id: bcs.Address,
  funder: bcs.Address,
  worker: bcs.Address,
  amount_mist: bcs.u64(),
  brief_hash: bcs.vector(bcs.u8()),
  deadline_ms: bcs.u64(),
});
const submittedEvent = bcs.struct('WorkSubmittedFixture', {
  job_id: bcs.Address,
  funder: bcs.Address,
  worker: bcs.Address,
  commitment_hash: bcs.vector(bcs.u8()),
  submitted_at_ms: bcs.u64(),
});
const settledEvent = (name: string) => bcs.struct(name, {
  job_id: bcs.Address,
  funder: bcs.Address,
  worker: bcs.Address,
  amount_mist: bcs.u64(),
});
const releasedEvent = settledEvent('JobReleasedFixture');
const refundedEvent = settledEvent('JobRefundedFixture');

function receiptClient(eventName: string, sender: string, eventBytes: Uint8Array): SuiGrpcClient {
  return {
    waitForTransaction: async () => ({
      $kind: 'Transaction',
      Transaction: {
        digest,
        status: { success: true, error: null },
        transaction: { sender },
        events: [{
          packageId,
          module: 'job_escrow',
          sender,
          eventType: `${packageId}::job_escrow::${eventName}`,
          bcs: eventBytes,
          json: null,
        }],
      },
    }),
  } as unknown as SuiGrpcClient;
}

const createdClient = receiptClient('JobCreated', funder, createdEvent.serialize({
    job_id: jobId,
    funder,
    worker,
    amount_mist: '42000000',
    brief_hash: briefHash,
    deadline_ms: '9000000000000',
  }).toBytes());

const receipt = await validateEscrowReceipt({
  packageId,
  digest,
  expectedKind: 'created',
  expectedActor: funder,
}, createdClient);
assert.equal(receipt.jobId, jobId);
assert.equal(receipt.amountMist, '42000000');
assert.equal(receipt.briefHash, `0x${Buffer.from(briefHash).toString('hex')}`);
assert.equal(receipt.deadlineMs, '9000000000000');
await assert.rejects(validateEscrowReceipt({
  packageId,
  digest,
  expectedKind: 'created',
  expectedActor: worker,
}, createdClient));

const submitted = await validateEscrowReceipt({
  packageId,
  digest,
  expectedKind: 'submitted',
  expectedActor: worker,
}, receiptClient('WorkSubmitted', worker, submittedEvent.serialize({
  job_id: jobId,
  funder,
  worker,
  commitment_hash: commitmentHash,
  submitted_at_ms: '12345',
}).toBytes()));
assert.equal(submitted.commitmentHash, `0x${Buffer.from(commitmentHash).toString('hex')}`);

for (const [kind, eventName, schema] of [
  ['released', 'JobReleased', releasedEvent],
  ['refunded', 'JobRefunded', refundedEvent],
] as const) {
  const settlementReceipt = await validateEscrowReceipt({
    packageId,
    digest,
    expectedKind: kind,
    expectedActor: funder,
  }, receiptClient(eventName, funder, schema.serialize({
    job_id: jobId,
    funder,
    worker,
    amount_mist: '42000000',
  }).toBytes()));
  assert.equal(settlementReceipt.amountMist, '42000000');
}

console.log('Sui escrow builder and BCS receipt checks passed.');
