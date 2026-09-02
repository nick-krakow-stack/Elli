import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Elli – Lerntrainer",
  description: "Kurze Übungen, direktes Feedback und klare Lernziele.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="de">
      <body className="antialiased">{children}</body>
    </html>
  );
}
