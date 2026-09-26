import type { NextConfig } from 'next';

const config: NextConfig = {
  poweredByHeader: false,
  agentRules: false,
  experimental: { cpus: 1 },
  async redirects() {
    return [
      {
        source: '/eth-tokyo-qr',
        destination: '/',
        permanent: false,
      },
    ];
  },
};

export default config;
