import type { Metadata } from "next";
import SiteHeader from "@/components/SiteHeader";
import { display, mono, marker } from "./fonts";
import "./globals.css";

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
    <html lang="en" className={`${display.variable} ${mono.variable} ${marker.variable} h-full`}>
      <body className="min-h-full flex flex-col">
        {/* Header */}
        <SiteHeader />

        {/* Main content */}
        <main className="flex-1">{children}</main>
      </body>
    </html>
  );
}
