export async function getServerSideProps() {
  const res = await fetch('/api/ping'); // relative path
  return { props: { ok: res.ok } };
}
export default function SSRTest({ ok }: { ok: boolean }) {
  return <pre>{JSON.stringify({ ok })}</pre>;
}
