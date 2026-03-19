import { Container } from '@/components/Container';
import { GlassCard } from '@/components/GlassCard';
import { Section } from '@/components/Section';

export default function TelecomPage() {
  return (
    <>
      <Section>
        <Container>
          <div className="h1 mb-4">PeakOps — Telecom</div>
          <p className="p mb-6">
            Dispatch, job evidence, GPS, and closeout for tower & fiber crews. Glassy, fast, field-ready.
          </p>
        </Container>
      </Section>
      <Section>
        <Container>
          <GlassCard>
            <div className="h2 mb-1">Evidence Engine</div>
            <p className="p">Photo/video proof auto-tagged by stage & GPS. Prevent closeout until required proof exists.</p>
          </GlassCard>
        </Container>
      </Section>
    </>
  );
}
