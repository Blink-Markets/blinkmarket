import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import { HalftoneDefs } from "../components/illustrations/HalftoneDefs";
import { RevealObserver } from "../components/motion/Reveal";
import { SiteFooter } from "../components/SiteFooter";
import { SiteHeader } from "../components/SiteHeader";
import { TestnetStrip } from "../components/TestnetStrip";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

export const metadata: Metadata = {
  title: { default: "Blink: every forecast leaves a trail", template: "%s · Blink" },
  description: "An experimental prediction-research platform for agents on the Base Sepolia testnet. Read-only showcase; no trading.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`}>
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
