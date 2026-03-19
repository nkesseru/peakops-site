// stormblastinator/telecom_blast.cjs

const {
  apiKey,
  telecomUrl,
  telecomValidCount,
  telecomGarbageCount,
} = require("./stormblast_config.cjs");

function makeValidTelecomRows(count) {
  const rows = [];
  const now = new Date();

  for (let i = 0; i < count; i++) {
    const start = new Date(now.getTime() - (i + 1) * 60 * 60 * 1000); // 1h steps
    const end = new Date(start.getTime() + 2 * 60 * 60 * 1000); // +2h

    rows.push({
      ticketId: `INC-${1000 + i}`,
      status: i % 3 === 0 ? "OPEN" : "RESOLVED",
      outageStart: start.toISOString(),
      outageEnd: i % 3 === 0 ? null : end.toISOString(),
      state: "WA",
      county: "Spokane",
      customersAffected: Math.floor(Math.random() * 200),
      description: `StormBlastinator test incident ${i}`,
    });
  }
  return rows;
}

function makeGarbageTelecomRows(count) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const flavor = i % 4;
    if (flavor === 0) {
      rows.push({
        // missing ticketId
        status: "RESOLVED",
        outageStart: "not-a-date",
      });
    } else if (flavor === 1) {
      rows.push({
        ticketId: `BAD-${i}`,
        status: "RESOLVED",
        outageStart: "2024-11-15T03:00:00Z",
        outageEnd: "not-a-date",
        customersAffected: -5,
      });
    } else if (flavor === 2) {
      rows.push({
        ticketId: `BAD-${i}`,
        status: "BROKEN",
        outageStart: "2024-11-15T03:00:00Z",
      });
    } else {
      rows.push({});
    }
  }
  return rows;
}

async function run() {
  const validRows = makeValidTelecomRows(telecomValidCount);
  const badRows = makeGarbageTelecomRows(telecomGarbageCount);

  const rows = [...validRows, ...badRows];

  console.log(
    `StormBlastinator: sending ${rows.length} telecom rows (${validRows.length} valid, ${badRows.length} garbage)`
  );

  const body = {
    orgId: "butler-pud",
    source: "BUTLER_EXPORT",
    importedBy: "stormblastinator",
    rows,
  };

  const res = await fetch(telecomUrl, {
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
    console.log("Telecom blast complete.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("Telecom blast ERROR:", err);
    process.exit(1);
  });
