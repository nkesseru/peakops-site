'use client';
import { motion } from 'framer-motion';
import { Container } from './Container';
export function Hero(){
  return (
    <Container>
      <div className="grid md:grid-cols-2 gap-8 items-center py-16">
        <motion.div initial={{opacity:0, y:10}} animate={{opacity:1,y:0}} transition={{duration:.35}}>
          <h1 className="h1 mb-4">The glassy ops layer your field teams actually love</h1>
          <p className="p mb-6">PeakOps brings dispatch, job evidence, GPS, and closeout into one elegant interface. Fast for techs, powerful for managers.</p>
          <div className="flex gap-3">
            <a href="#pricing" className="btn btn-primary">Start Free Pilot</a>
            <a href="#features" className="btn btn-glass">See Features</a>
          </div>
        </motion.div>
        <motion.div initial={{opacity:0, scale:0.98}} animate={{opacity:1, scale:1}} transition={{duration:.35, delay:.1}}>
          <div className="glass round-24 p-3">
            <div className="aspect-[16/10] w-full rounded-2xl bg-[rgba(255,255,255,0.04)] border border-[var(--border)]"/>
          </div>
        </motion.div>
      </div>
    </Container>
  );
}
