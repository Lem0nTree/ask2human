import { isIP } from 'node:net';

export const DEFAULT_BASE_URL = 'https://ask2human.me';
export const API_PATH = '/api/agent-tools';
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const MAX_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_RESPONSE_BYTES = 256 * 1024;

const API_KEY_PATTERN = /^gw_live_[A-Za-z0-9_-]{30,}$/;

export class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

/**
 * Keep HTTP development endpoints on literal loopback hosts. DNS names that
 * might resolve to a private address are not sufficient for this exception.
 */
export function isLoopbackHostname(hostname) {
  const normalized = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost') return true;
  const ipVersion = isIP(normalized);
  if (ipVersion === 6) return normalized === '::1';
  if (ipVersion === 4) return normalized.split('.')[0] === '127';
  return false;
}

export function validateBaseUrl(value = DEFAULT_BASE_URL) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    throw new ConfigurationError('ASK2HUMAN_BASE_URL must be a URL origin.');
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigurationError('ASK2HUMAN_BASE_URL must be a URL origin.');
  }

  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new ConfigurationError('ASK2HUMAN_BASE_URL must not contain credentials, a path, a query, or a fragment.');
  }
  if (parsed.protocol === 'https:') return parsed.origin;
  if (parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname)) return parsed.origin;
  throw new ConfigurationError('ASK2HUMAN_BASE_URL must use HTTPS; HTTP is allowed only for loopback testing.');
}

export function validateApiKey(value) {
  if (typeof value !== 'string' || !API_KEY_PATTERN.test(value)) {
    throw new ConfigurationError('ASK2HUMAN_API_KEY must be a gw_live_ agent credential.');
  }
  return value;
}

export function readConfig(env = process.env) {
  const apiKey = validateApiKey(env.ASK2HUMAN_API_KEY);
  const baseUrl = validateBaseUrl(env.ASK2HUMAN_BASE_URL || DEFAULT_BASE_URL);
  return { apiKey, baseUrl };
}

export function validateTimeout(value = DEFAULT_REQUEST_TIMEOUT_MS) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_REQUEST_TIMEOUT_MS) {
    throw new ConfigurationError(`Request timeout must be an integer between 1 and ${MAX_REQUEST_TIMEOUT_MS} milliseconds.`);
  }
  return value;
}
