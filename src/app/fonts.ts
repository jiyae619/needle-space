// One place for the site's fonts, so the layout and the landing page share a
// single download of each. Bricolage carries headlines and body text; Martian
// Mono labels the header chips on every page (and the 3D cup's print); the
// barista's Permanent Marker is landing-page only, so it isn't preloaded.
import { Bricolage_Grotesque, Martian_Mono, Permanent_Marker } from "next/font/google";

export const display = Bricolage_Grotesque({ subsets: ["latin"], axes: ["opsz", "wdth"], variable: "--font-display" });
export const mono = Martian_Mono({ subsets: ["latin"], axes: ["wdth"], variable: "--font-mono" });
export const marker = Permanent_Marker({ subsets: ["latin"], weight: "400", variable: "--font-marker", preload: false });
