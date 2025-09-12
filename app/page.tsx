import { Hero } from '@/components/Hero';
import { Features } from '@/components/Features';
import { CTA } from '@/components/CTA';
import { Footer } from '@/components/Footer';
import { Section } from '@/components/Section';

export default function Page(){
  return (
    <>
      <Hero/>
      <Section>
        <Features/>
      </Section>
      <Section>
        <CTA/>
      </Section>
      <Footer/>
    </>
  );
}
