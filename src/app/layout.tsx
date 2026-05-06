import type { Metadata } from "next";
import { Fraunces, DM_Sans } from "next/font/google";
import AlgorithmExplainer from "@/components/AlgorithmExplainer";
import "./globals.css";

const fraunces = Fraunces({
  variable: "--font-display",
  subsets: ["latin"],
  axes: ["SOFT", "WONK", "opsz"],
});

const dmSans = DM_Sans({
  variable: "--font-body",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Needle Space — Find Laptop-Friendly Cafes in Seattle",
  description:
    "Discover work-friendly cafes with fast WiFi, power outlets, and good vibes. Built for remote workers, students, and digital nomads in Seattle.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${fraunces.variable} ${dmSans.variable} h-full`}>
      <body className="min-h-full flex flex-col">
        {/* Header */}
        <header className="sticky top-0 z-50 gs-header border-b border-[var(--gs-rule)]">
          <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
            <a href="/" className="flex items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/needle-space-icon-no-bcg.png"
                alt=""
                className="h-[34px] w-auto shrink-0"
              />
              <span className="font-display font-bold text-[1.25rem] tracking-[-0.015em] text-[var(--gs-espresso)]">
                Needle Space
              </span>
            </a>
            <nav className="flex items-center gap-1 sm:gap-3">
              <AlgorithmExplainer />
              <a
                href="/explore"
                className="gs-nav-link text-xs tracking-widest uppercase px-2.5 py-1.5 rounded-sm"
              >
                Browse
              </a>
              <a
                href="/treasure"
                className="gs-nav-pill text-xs tracking-widest uppercase px-3 py-1.5 rounded-sm"
              >
                Surprise me
              </a>
            </nav>
          </div>
        </header>

        {/* Main content */}
        <main className="flex-1">{children}</main>
      </body>
    </html>
  );
}
