"use client";

import dynamic from "next/dynamic";

// The wallet UI registers browser custom elements at import time.
// Keep that boundary on the button so page layouts can still render on the server.
export const ConnectButton = dynamic(
  () => import("@mysten/dapp-kit-react/ui").then((module) => module.ConnectButton),
  { ssr: false, loading: () => <button className="button button--small" disabled>Connect wallet</button> },
);
