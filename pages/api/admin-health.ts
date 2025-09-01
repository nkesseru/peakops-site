import type { NextApiRequest, NextApiResponse } from "next";
import { getAdminDb } from "../../lib/firebaseAdmin";
export default async function handler(_:NextApiRequest,res:NextApiResponse){
  try {
    await getAdminDb().collection("_health").limit(1).get();
    res.status(200).json({ ok: true });
  } catch (e:any) {
    res.status(500).json({ ok:false, error:e.message });
  }
}
