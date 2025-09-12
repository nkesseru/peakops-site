import { Container } from './Container';
export function Footer(){
  return (
    <Container>
      <div className="mt-16 mb-10 text-sm text-text-secondary flex flex-col md:flex-row items-center justify-between gap-3">
        <div>© {new Date().getFullYear()} PeakOps</div>
        <div className="flex gap-4">
          <a href="#privacy">Privacy</a>
          <a href="#terms">Terms</a>
          <a href="#security">Security</a>
        </div>
      </div>
    </Container>
  );
}
