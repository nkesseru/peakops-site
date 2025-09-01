import type { NextApiRequest, NextApiResponse } from "next";

export default function handler(_: NextApiRequest, res: NextApiResponse) {
  res.status(200).json({
    FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID ? "✅ set" : "❌ missing",
    FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL ? "✅ set" : "❌ missing",
    FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY ? "✅ set" : "❌ missing",
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ? "✅ set" : "❌ missing",
  });
}
