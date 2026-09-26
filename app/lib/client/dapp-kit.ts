"use client";

import { createDAppKit } from "@mysten/dapp-kit-react";
import { SuiGrpcClient } from "@mysten/sui/grpc";

const MAINNET_URL = "https://fullnode.mainnet.sui.io:443";

export const dAppKit = createDAppKit({
  networks: ["mainnet"],
  defaultNetwork: "mainnet",
  slushWalletConfig: { appName: "ask2human", origin: "https://my.slush.app" },
  autoConnect: true,
  createClient: (network) => new SuiGrpcClient({ network, baseUrl: MAINNET_URL }),
});

declare module "@mysten/dapp-kit-react" {
  interface Register {
    dAppKit: typeof dAppKit;
  }
}
