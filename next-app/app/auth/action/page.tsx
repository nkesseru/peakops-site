import AuthActionClient from "./AuthActionClient";

// PEAKOPS_AUTH_ACTION_IN_APP_V1 (PR 49 Phase B)
// Single in-app handler for the Firebase Auth out-of-band action
// codes (password reset today; could host email verification and
// magic-link recovery in the future). Stops the previous redirect
// chain through *.firebaseapp.com → accounts.google.com that was
// landing users on Google's account security settings page.
//
// The client component does all the work — it has to read the URL
// query params, call confirmPasswordReset, and react to outcomes.

export default async function AuthActionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const mode = String(params?.mode || "").trim();
  const oobCode = String(params?.oobCode || "").trim();
  const continueUrl = String(params?.continueUrl || "").trim();
  return (
    <AuthActionClient mode={mode} oobCode={oobCode} continueUrl={continueUrl} />
  );
}
