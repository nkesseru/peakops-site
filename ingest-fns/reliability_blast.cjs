#!/usr/bin/env node

import('node-fetch').then(async ({ default: fetch }) => {
  const url = 'https://reliabilityingest-2omfo6m6ea-uc.a.run.app';
  const apiKey = process.env.INGEST_API_KEY || 'YOUR_INGEST_API_KEY_HERE';

  const body = {
    orgId: 'demo-org',
    source: 'UTILITY_EXPORT',
    regionId: 'SYSTEM',
    importedBy: 'nick',
    rows: [
      { year: 2022, saidi: 1.3, saifi: 0.5, caidi: 2.0 },
      { year: 2023, saidi: 1.8, saifi: 0.7, caidi: 2.3 },
    ],
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-peakops-key': apiKey,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  console.log('Status:', res.status);
  console.log('Body:', text);
}).catch(err => {
  console.error('Blast failed:', err);
  process.exit(1);
});
