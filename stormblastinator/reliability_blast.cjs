// stormblastinator/reliability_blast.cjs

const {
  apiKey,
  reliabilityUrl,
  reliabilityValidCount,
  reliabilityGarbageCount,
} = require("./stormblast_config.cjs");

// Generate valid rows
function makeValidReliabilityRows(count) {
  const rows = [];
  const currentYear = new Date().getFullYear();

  for (let i = 0; i < count; i++) {
    const year = currentYear - (i % 3); // last 3 years
    rows.push({
      year,
      saidi: Number((Math.random() * 3).toFixed(2)), // 0–3 hours
      saifi: Number((Math.random() * 2).toFixed(2)), // 0–2 events
      caidi: Number((Math.random() * 4).toFixed(2)), // 0–4 hours
    });
  }
  return rows;
}

// Generate intentionally bad rows
function makeGarbageReliabilityRows(count) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const flavor = i % 4;
    if (flavor === 0) {
      rows.push({ year: 1800, saidi: 1.2 }); // invalid year
    } else if (flavor === 1) {
      rows.push({ year: "not-a-year", saifi: "abc" }); // nonsense
    } else if (flavor === 2) {
      rows.push({ year: 2023, saidi: 99999 }); // insane SAIDI
    } else {
      rows.push({}); // missing everything
    }
  }
  return rows;
}

async function run() {
  const validRows = makeValidReliabilityRows(reliabilityValidCount);
  const badRows = makeGarbageReliabilityRows(reliabilityGarbageCount);

  const rows = [...validRows, ...badRows];

  console.log(
    `StormBlastinator: sending ${rows.length} reliability rows (${validRows.length} valid, ${badRows.length} garbage)`
  );

  const body = {
    orgId: "demo-org",
    source: "UTILITY_EXPORT",
    regionId: "SYSTEM",
    importedBy: "stormblastinator",
    rows,
  };

  const res = await fetch(reliabilityUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-peakops-key": apiKey,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  console.log("HTTP status:", res.status);
  console.log("Response body:", text);

  try {
    const json = JSON.parse(text);
    console.log(
      "Parsed result → accepted:",
      json.accepted,
      "rejected:",
      json.rejected
    );
  } catch {
    console.log("Could not parse JSON response.");
  }
}

run()
  .then(() => {
    console.log("Reliability blast complete.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("Reliability blast ERROR:", err);
    process.exit(1);
  });
