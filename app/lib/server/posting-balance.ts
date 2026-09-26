import { T2000_COIN_TYPE, t2000Config } from '../sui/t2000';
import { HttpError } from './errors';

/** Keep the posting check short enough that a fullnode outage does not hold a
 * database owner lock indefinitely.  The client request also receives an
 * abort signal; the timer is cleared in every completion path. */
export const POSTING_BALANCE_TIMEOUT_MS = 5_000;

type PostingBalanceResponse = {
  balance?: {
    balance?: unknown;
  };
};

export type PostingBalanceReader = (input: {
  owner: string;
  coinType: typeof T2000_COIN_TYPE;
  signal: AbortSignal;
}) => Promise<unknown>;

/**
 * An explicit dependency seam for server-side integration tests.  Production
 * callers omit it and use the canonical t2000 mainnet client below.  The
 * seam is passed only through the server function call; it is never read from
 * request data or process environment.
 */
export type PostingBalanceDependency = {
  readBalance: PostingBalanceReader;
  timeoutMs?: number;
};

function canonicalBalanceReader(input: Parameters<PostingBalanceReader>[0]): Promise<unknown> {
  const config = t2000Config();
  return config.client.getBalance({ owner: input.owner, coinType: input.coinType, signal: input.signal });
}

function unavailableBalanceError(): HttpError {
  return new HttpError(503, 'owner_balance_unavailable', 'The owner wallet balance could not be verified right now.');
}

function parseAtomic(value: unknown, label: string): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new Error(`${label} must be non-negative`);
    return value;
  }
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${label} must be an unsigned decimal string`);
  }
  return BigInt(value);
}

function balanceFromResponse(response: unknown): bigint {
  if (!response || typeof response !== 'object') throw new Error('balance response is not an object');
  const nested = (response as PostingBalanceResponse).balance;
  if (!nested || typeof nested !== 'object') throw new Error('balance response is missing its balance object');
  return parseAtomic(nested.balance, 'wallet balance');
}

/**
 * Require a fresh canonical mainnet-USDC balance for a posting.  This helper
 * only reads chain state; it never builds, signs, or submits a transaction.
 */
export async function assertSufficientPostingBalance(
  owner: string,
  requiredAtomic: string | bigint,
  dependency?: PostingBalanceDependency,
): Promise<void> {
  const required = parseAtomic(requiredAtomic, 'required posting amount');
  const timeoutMs = dependency?.timeoutMs ?? POSTING_BALANCE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw unavailableBalanceError();

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reader = dependency?.readBalance ?? canonicalBalanceReader;
  const request = Promise.resolve().then(() => reader({ owner, coinType: T2000_COIN_TYPE, signal: controller.signal }));
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('wallet balance request timed out'));
    }, timeoutMs);
  });

  try {
    const response = await Promise.race([request, timeout]);
    const available = balanceFromResponse(response);
    if (available < required) {
      throw new HttpError(409, 'insufficient_owner_balance', 'Your wallet needs enough mainnet USDC for this task and your other active listings. Add USDC or cancel an open task.');
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw unavailableBalanceError();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}
