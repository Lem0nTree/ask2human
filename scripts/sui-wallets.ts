import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

const directory = resolve(process.env.SUI_DEV_WALLET_DIR ?? join(homedir(), '.config/ask2human'));
mkdirSync(directory, { recursive: true, mode: 0o700 });
chmodSync(directory, 0o700);

for (const role of ['owner', 'worker'] as const) {
  const keypair = Ed25519Keypair.generate();
  const path = join(directory, `${role}.key`);
  writeFileSync(path, `${keypair.getSecretKey()}\n`, { flag: 'wx', mode: 0o600 });
  chmodSync(path, 0o600);
  console.log(`${role} address: ${keypair.toSuiAddress()}`);
}

console.log(`Development wallet files created with mode 0600 in ${directory}`);
