import type { Metadata } from 'next';
import site from './site-config.json';

export function pageMetadata(
  path: string,
  title = site.title,
  description = site.description,
): Metadata {
  const url = new URL(path, site.origin).href;
  return {
    title,
    description,
    metadataBase: new URL(site.origin),
    alternates: { canonical: url },
    robots: { index: site.indexable, follow: true },
    icons: { icon: '/favicon.svg' },
    openGraph: {
      type: 'website',
      title,
      description,
      url,
      siteName: site.name,
      locale: 'en_US',
    },
    twitter: { card: 'summary', title, description },
  };
}

export const projectSchema = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareSourceCode',
  name: site.name,
  description: site.description,
  url: site.origin,
  codeRepository: site.repository,
  license: site.repository + '/blob/master/LICENSE',
  programmingLanguage: 'TypeScript',
};
