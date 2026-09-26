import type { NextConfig } from 'next';

const config: NextConfig = {
  poweredByHeader: false,
  agentRules: false,
  experimental: { cpus: 1 },
};

export default config;
