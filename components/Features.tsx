import { Container } from './Container';
import { GlassCard } from './GlassCard';
import { MapPin, Upload, CheckCircle2 } from 'lucide-react';
export function Features(){
  const items = [
    {icon: Upload, title: 'Evidence Engine', body: 'Photo/video proof auto-tagged by stage & GPS.'},
    {icon: MapPin, title: 'Precision GPS', body: 'Snap geolocation & altitude with one tap.'},
    {icon: CheckCircle2, title: 'Closeout Guard', body: 'Prevents completion until required proof exists.'},
  ];
  return (
    <Container>
      <div id="features" className="grid md:grid-cols-3 gap-6">
        {items.map(({icon:Icon, title, body}) => (
          <GlassCard key={title}>
            <div className="flex items-start gap-3">
              <Icon className="w-5 h-5 text-teal"/>
              <div>
                <div className="h2 mb-1">{title}</div>
                <p className="p">{body}</p>
              </div>
            </div>
          </GlassCard>
        ))}
      </div>
    </Container>
  );
}
