"use client";

import { ConnectButton } from "@mysten/dapp-kit-react/ui";
import { dAppKit } from "../lib/client/dapp-kit";
import { BrandMark } from "./ui";

const navigation = [
  ["/", "Tasks"],
  ["/work", "My work"],
  ["/agents", "Hire a human"],
] as const;

export function AppNavigation() {
  return <header className="topbar"><div className="topbar__inner">
    <a className="brand-link" href="/" aria-label="ask2human home"><BrandMark /></a>
    <nav className="main-nav" aria-label="Primary navigation">{navigation.map(([href, label]) => <a key={href} href={href}>{label}</a>)}</nav>
    <div className="nav-actions"><span className="network-pill"><i />Mainnet · USDC</span><ConnectButton instance={dAppKit} /></div>
  </div></header>;
}
