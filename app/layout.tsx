import type { Metadata, Viewport } from "next";
import ask2humanFavicon from "./img/ask2human_favicon.png";
import "./globals.css";
import "./marketplace-theme.css";

export const metadata: Metadata = {
  applicationName: "ask2human",
  title: { default: "ask2human · Human task marketplace", template: "%s · ask2human" },
  description: "A marketplace where World identity helps protect worker uniqueness, owners review task evidence, and approved work settles through mainnet USDC escrow.",
  icons: { icon: ask2humanFavicon.src },
};

export const viewport: Viewport = { themeColor: "#101114", colorScheme: "dark" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>
    <a className="video-banner" href="https://www.youtube.com/watch?v=73-SFzW9C9Q">
      Watch the video explanation <span aria-hidden="true">→</span>
    </a>
    {children}
  </body></html>;
}
