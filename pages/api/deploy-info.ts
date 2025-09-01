import type { NextApiRequest, NextApiResponse } from "next";
export default function handler(_:NextApiRequest,res:NextApiResponse){
  res.status(200).json({
    commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
    vercelUrl: process.env.VERCEL_URL || null,
    nextPublicSiteUrl: process.env.NEXT_PUBLIC_SITE_URL || null,
    hasClientEnv: !!process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    hasAdminEnv: !!(process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY),
  });
}
