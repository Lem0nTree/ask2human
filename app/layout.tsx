import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./marketplace-theme.css";

export const metadata: Metadata = {
  applicationName: "ask2human",
  title: { default: "ask2human · Human task marketplace", template: "%s · ask2human" },
  description: "A marketplace where World identity helps protect worker uniqueness, owners review task evidence, and approved work settles through mainnet USDC escrow.",
};

export const viewport: Viewport = { themeColor: "#101114", colorScheme: "dark" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
