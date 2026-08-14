import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
  const incoming = await headers();
  const host = incoming.get("x-forwarded-host") || incoming.get("host") || "localhost:3000";
  const protocol = incoming.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  const imageUrl = `${protocol}://${host}/og.png`;
  return {
    title: "Marketplace Performance Controller",
    description: "A transparent, margin-aware controller for Amazon, Kaufland and future marketplaces.",
    openGraph: {
      title: "Marketplace Performance Controller",
      description: "Compare marketplaces, control bidding rules and retain every reporting period.",
      images: [{ url: imageUrl, width: 1200, height: 630, alt: "Marketplace Performance Controller dashboard" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Marketplace Performance Controller",
      description: "Compare marketplaces, control bidding rules and retain every reporting period.",
      images: [imageUrl],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body></html>;
}
