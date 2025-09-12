import { Container } from './Container';
export function CTA(){
  return (
    <Container>
      <div className="glass round-24 p-8 md:p-10 flex flex-col md:flex-row md:items-center md:justify-between gap-6">
        <div>
          <div className="h2 mb-1">Run a 60‑day pilot with real crews</div>
          <p className="p">We set up your org, roles, and job stages. You get data, not promises.</p>
        </div>
        <a href="#contact" className="btn btn-secondary">Book Pilot</a>
      </div>
    </Container>
  );
}
