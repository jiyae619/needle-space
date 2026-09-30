// One place for the site's fonts, so the layout and the landing page share a
// single download of each. Bricolage carries headlines and body text; Martian
// Mono and Permanent Marker are used by the landing page (the 3D cup's print
// and the barista's handwriting), so they aren't preloaded on other pages.
import { Bricolage_Grotesque, Martian_Mono, Permanent_Marker } from "next/font/google";

export const display = Bricolage_Grotesque({ subsets: ["latin"], axes: ["opsz", "wdth"], variable: "--font-display" });
export const mono = Martian_Mono({ subsets: ["latin"], axes: ["wdth"], variable: "--font-mono", preload: false });
export const marker = Permanent_Marker({ subsets: ["latin"], weight: "400", variable: "--font-marker", preload: false });
