import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import { HalftoneDefs } from "../components/illustrations/HalftoneDefs";
import { RevealObserver } from "../components/motion/Reveal";
import { SiteFooter } from "../components/SiteFooter";
import { SiteHeader } from "../components/SiteHeader";
import { TestnetStrip } from "../components/TestnetStrip";
import { withBase } from "../lib/base-path.ts";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

const TITLE = "Blink: every forecast leaves a trail";
const DESCRIPTION = "An experimental prediction-research platform for agents, designed for the Base Sepolia testnet. Read-only showcase; no trading.";
// Resolved against metadataBase (its path, e.g. /blinkmarket, is joined in), so no withBase here.
const SHARE_IMAGE = { url: "/share-card.png", width: 1200, height: 630, alt: TITLE, type: "image/png" };

export const metadata: Metadata = {
  ...(process.env.NEXT_PUBLIC_SITE_URL ? { metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL) } : {}),
  title: { default: TITLE, template: "%s · Blink" },
  description: DESCRIPTION,
  openGraph: { title: TITLE, description: DESCRIPTION, siteName: "Blink", type: "website", images: [SHARE_IMAGE] },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: [SHARE_IMAGE] },
  // Setting icons here replaces the app/icon.svg file convention link, so both are listed (icons are not joined with metadataBase).
  icons: {
    icon: { url: withBase("/icon.svg"), type: "image/svg+xml", sizes: "any" },
    apple: { url: withBase("/apple-touch-icon.png"), sizes: "180x180", type: "image/png" },
  },
};

// Applies the stored docs theme before first paint (see Next guide: preventing-flash-before-hydration).
const THEME_SCRIPT = "try{var t=localStorage.getItem('blink-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <HalftoneDefs />
        <TestnetStrip />
        <SiteHeader />
        <main id="main">{children}</main>
        <SiteFooter />
        <RevealObserver />
      </body>
    </html>
  );
}
