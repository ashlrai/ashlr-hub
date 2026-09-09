import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Ashlr Universe — the local engineering loop',
  description:
    'Explore a real, credential-free engineering experiment. Competing approaches, fixed evaluation, retained artifacts, and measured improvement.',
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
