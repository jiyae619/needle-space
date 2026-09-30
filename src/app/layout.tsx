import Link from "next/link";
import type { Metadata } from "next";
import { Fraunces, DM_Sans } from "next/font/google";
import SiteNav from "@/components/SiteNav";
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
          <div className="gs-page h-14 flex items-center justify-between">
            <Link href="/" className="flex items-center gap-2 sm:gap-3 min-w-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/needle-space-icon-no-bcg.png"
                alt=""
                className="h-7 sm:h-[34px] w-auto shrink-0"
              />
              <span className="font-display font-medium text-base sm:text-[1.25rem] tracking-[-0.015em] text-[var(--gs-espresso)] whitespace-nowrap">
                Needle Space
              </span>
            </Link>
            <SiteNav />
          </div>
        </header>

        {/* Main content */}
        <main className="flex-1">{children}</main>
      </body>
    </html>
  );
}
