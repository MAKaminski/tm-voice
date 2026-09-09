import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";

export const metadata = { title: "TM Voice Console", description: "Transparent Maintenance outbound voice agent" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav>
          <Link className="brand" href="/">TM Voice</Link>
          <Link href="/">Campaigns</Link>
          <Link href="/review">Review queue</Link>
          <Link href="/live">Live board</Link>
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
