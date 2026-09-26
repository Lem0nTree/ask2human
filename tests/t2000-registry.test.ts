import assert from 'node:assert/strict';
import test from 'node:test';
import { bcs } from '@mysten/sui/bcs';
import { isT2000RegisteredAgent } from '../app/lib/sui/t2000.ts';

const registryId = `0x${'1'.repeat(64)}`;
const tableId = `0x${'2'.repeat(64)}`;
const agent = `0x${'3'.repeat(64)}`;
const otherAgent = `0x${'4'.repeat(64)}`;

function fieldFor(address: string) {
  return { name: { bcs: bcs.Address.serialize(address).toBytes() } };
}

test('Agent-ID membership lists the Registry.agents table, not the Registry UID', async () => {
  const parents: string[] = [];
  const client = {
    core: {
      getObject: async () => ({ object: { json: { agents: { id: tableId, size: '1' } } } }),
      listDynamicFields: async ({ parentId }: { parentId: string }) => {
        parents.push(parentId);
        return { dynamicFields: [fieldFor(agent)], hasNextPage: false, cursor: null };
      },
    },
  } as unknown as Parameters<typeof isT2000RegisteredAgent>[0];

  assert.equal(await isT2000RegisteredAgent(client, registryId, agent), true);
  assert.deepEqual(parents, [tableId]);
  assert.equal(await isT2000RegisteredAgent(client, registryId, otherAgent), false);
});

test('Agent-ID membership fails closed when Registry.agents is malformed', async () => {
  let listed = false;
  const client = {
    core: {
      getObject: async () => ({ object: { json: { agents: { id: 'not-an-address' } } } }),
      listDynamicFields: async () => {
        listed = true;
        return { dynamicFields: [], hasNextPage: false, cursor: null };
      },
    },
  } as unknown as Parameters<typeof isT2000RegisteredAgent>[0];

  await assert.rejects(() => isT2000RegisteredAgent(client, registryId, agent), /agents table ID/);
  assert.equal(listed, false);
});

test('Agent-ID membership fails closed on malformed table pagination', async () => {
  const client = {
    core: {
      getObject: async () => ({ object: { json: { agents: { id: tableId } } } }),
      listDynamicFields: async () => ({ dynamicFields: [{ name: { bcs: 'not-bytes' } }], hasNextPage: false, cursor: null }),
    },
  } as unknown as Parameters<typeof isT2000RegisteredAgent>[0];

  await assert.rejects(() => isT2000RegisteredAgent(client, registryId, agent), /dynamic-field key is malformed/);
});
