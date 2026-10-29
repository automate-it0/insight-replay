import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

// Side-effect import — kicks off server-side background tasks (Admin Radar)
// once per Node.js process. See src/lib/startup.ts for the wiring.
import "@/lib/startup";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Insight Replay — Session Replay, Heatmaps & Live Analytics",
  description:
    "A Microsoft Clarity-style analytics platform: session recordings, click heatmaps, live visitor tracking, and behavioral insights.",
  keywords: ["analytics", "session replay", "heatmap", "live tracking", "Clarity"],
  authors: [{ name: "Insight Replay" }],
  icons: { icon: "/logo.svg" },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Read the per-request CSP nonce set by `src/middleware.ts` (via
  // `nextWithNonce()`). Applying it to the `<html>` element causes Next.js
  // to automatically propagate the nonce to every inline `<script>` it
  // emits (hydration chunks, runtime chunks, etc.) — this is the only way
  // those framework-generated inline scripts can pass the strict
  // `'nonce-<value>'` CSP. Without this attribute, the new nonce-based CSP
  // would block all of Next.js's own inline scripts and break the app.
  // `headers()` is async in Next.js 16 (it returns a Promise).
  const nonce = (await headers()).get("x-nonce") ?? "";

  return (
    <html lang="en" suppressHydrationWarning className="dark" nonce={nonce}>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {/* Skip-to-content link — first focusable element for keyboard users (WCAG 2.4.1) */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground focus:shadow-lg"
        >
          Skip to content
        </a>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
