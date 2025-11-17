#!/usr/bin/env node

import('node-fetch').then(async ({ default: fetch }) => {
  const url = 'https://telecomingest-2omfo6m6ea-uc.a.run.app';
  const apiKey = process.env.INGEST_API_KEY || 'YOUR_INGEST_API_KEY_HERE';

  const body = {
    orgId: 'demo-org',
    source: 'BUTLER_EXPORT',
    rows: [
      {
        ticketId: 'INC-1001',
        state: 'WA',
        county: 'Spokane',
        customersAffected: 120,
        description: 'Fiber cut near river',
        outageStart: '2025-10-01T02:30:00Z',
        outageEnd: '2025-10-01T04:10:00Z',
      },
      {
        ticketId: 'INC-1002',
        state: 'WA',
        county: 'Spokane',
        customersAffected: 65,
        description: 'Backhoe fade',
        outageStart: '2025-10-01T06:00:00Z',
        outageEnd: '2025-10-01T07:15:00Z',
      },
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
