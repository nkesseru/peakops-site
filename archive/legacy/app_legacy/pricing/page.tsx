import { Container } from '@/components/Container';
import { GlassCard } from '@/components/GlassCard';

const tiers = [
  { name: 'Pilot (60 days)', price: '$0', bullets: [
    'Org + roles + stages configured',
    'Up to 3 crews, 1 manager',
    'Evidence + GPS + Closeout',
  ], cta: 'Start Pilot' },
  { name: 'Ops Core', price: '$299/mo', bullets: [
    'Unlimited jobs & evidence',
    'Manager dashboard',
    'Email support, 24h SLA',
  ], cta: 'Book Demo' },
  { name: 'Ops Pro', price: '$499/mo', bullets: [
    'Priority support (4h SLA)',
    'Custom stages & flags',
    'Export & API access',
  ], cta: 'Book Demo' },
];

export default function PricingPage() {
  return (
    <Container>
      <h1 className="h1 mb-6">Pricing</h1>
      <p className="p mb-10">Start with a pilot; upgrade when your team’s ready.</p>
      <div className="grid md:grid-cols-3 gap-6">
        {tiers.map(t => (
          <GlassCard key={t.name}>
            <div className="h2 mb-2">{t.name}</div>
            <div className="text-3xl font-semibold mb-4">{t.price}</div>
            <ul className="p mb-6 list-disc pl-5 space-y-1">
              {t.bullets.map(b => <li key={b}>{b}</li>)}
            </ul>
            <a href="/contact" className="btn btn-primary">{t.cta}</a>
          </GlassCard>
        ))}
      </div>
    </Container>
  );
}
