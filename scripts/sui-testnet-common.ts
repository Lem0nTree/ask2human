import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromBase64 } from '@mysten/sui/utils';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import type { FrozenEscrowTransaction } from '../app/lib/sui/escrow.ts';

export const EXPECTED_TESTNET_CHAIN_ID = '69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD';
export const DEV_WALLET_DIRECTORY = resolve(
  process.env.SUI_DEV_WALLET_DIR ?? join(homedir(), '.config/ask2human'),
);

export function loadDevelopmentKeypair(role: 'owner' | 'worker'): Ed25519Keypair {
  const path = join(DEV_WALLET_DIRECTORY, `${role}.key`);
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0) {
    throw new Error(`Refusing insecure ${role} wallet key file; it must be a regular mode-0600 file`);
  }

  return Ed25519Keypair.fromSecretKey(readFileSync(path, 'utf8').trim());
}

export async function assertSuiTestnet(client: SuiGrpcClient): Promise<void> {
  const { chainIdentifier } = await client.getChainIdentifier();
  if (chainIdentifier !== EXPECTED_TESTNET_CHAIN_ID) {
    throw new Error(`Configured Sui RPC endpoint is not Sui testnet (chain identifier ${chainIdentifier})`);
  }
}

export async function executeFrozenTransaction(
  client: SuiGrpcClient,
  signer: Ed25519Keypair,
  frozen: FrozenEscrowTransaction,
): Promise<string> {
  const bytes = fromBase64(frozen.transactionBytesBase64);
  const { signature } = await signer.signTransaction(bytes);
  const result = await client.executeTransaction({
    transaction: bytes,
    signatures: [signature],
    include: { transaction: true, effects: true, events: true },
  });

  if (result.$kind !== 'Transaction') {
    throw new Error('Sui gRPC endpoint did not return a transaction result');
  }
  const transaction = result.Transaction;
  if (transaction.digest !== frozen.digest) {
    throw new Error(`Submitted transaction digest ${transaction.digest} did not match frozen digest`);
  }
  if (!transaction.effects?.status?.success) {
    throw new Error(`Sui transaction failed: ${transaction.effects?.status?.error ?? 'unknown execution error'}`);
  }

  return transaction.digest;
}
