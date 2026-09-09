import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Ashlrverse — an open frontier for builders',
  description:
    'An open-source, local-first engineering fleet. Explore possibilities, independently test artifacts, and build on measured progress.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
