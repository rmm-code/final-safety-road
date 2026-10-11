import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Inter } from "next/font/google";
import { Providers } from "@/components/providers";
import "./globals.css";

// Inter, as in the team's Pitstop console, for every label, heading and number. Cyrillic
// too: the public map is in Russian. Mono is reserved for identifiers and coordinates,
// where alignment and character distinction matter.
const inter = Inter({
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-inter",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Pitstop",
    template: "%s - Pitstop",
  },
  description: "Finds potholes in road video, grades them and puts them on the map.",
  manifest: "/manifest.webmanifest",
  applicationName: "Pitstop",
};

export const viewport: Viewport = {
  themeColor: "#f1f1f1",
  width: "device-width",
  initialScale: 1,
  // The live drive view is used on a windshield-mounted phone; zooming while driving
  // would be a hazard, and every control is already large enough.
  maximumScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${plexMono.variable}`}>
      <body className="min-h-screen bg-app text-primary antialiased">
        {/*
          Deliberately no chrome here. Two audiences share this application: the internal
          console, which has a sidebar, and the public map, which is a full-bleed page a
          stranger opens from Telegram. A layout that wrapped both would put an operator's
          navigation in front of the public - so each route group brings its own.
        */}
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
