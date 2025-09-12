import { readFileSync } from "fs";
import { GoogleAuth } from "google-auth-library";
const key = JSON.parse(readFileSync("./sa-peakops.json","utf8"));

const auth = new GoogleAuth({
  credentials: { client_email: key.client_email, private_key: key.private_key },
  scopes: ["https://www.googleapis.com/auth/cloud-platform"]
});

const client = await auth.getClient();
const { token } = await client.getAccessToken();
console.log("client_email:", key.client_email);
console.log("project_id :", key.project_id);
console.log("token length:", token?.length || 0);
if (!token) { throw new Error("No token minted"); }
console.log("✅ Token minted OK");
