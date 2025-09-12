import admin from "firebase-admin";
import serviceAccount from "../sa-peakops.json" assert { type: "json" };

const PROJECT_ID = process.env.PROJECT_ID || serviceAccount.project_id;
const ORG = process.env.ORG_ID || "peakops-telecom-pilot";

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: PROJECT_ID,
});

const db = admin.firestore();

async function main() {
  const jobRef = db
    .collection("organizations")
    .doc(ORG)
    .collection("jobs")
    .doc("demoJob");

  await jobRef.set(
    {
      siteName: "Demo Tower",
      status: "scheduled",
      assigneeIds: ["u-eric", "u-kirby"], // <-- array
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  console.log("✅ Added job with assignee array");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
