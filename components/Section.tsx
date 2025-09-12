import React from 'react';

export type SectionProps = {
  children: React.ReactNode;
  className?: string;
};

export function Section({ children, className = '' }: SectionProps) {
  return <section className={`py-12 md:py-16 ${className}`}>{children}</section>;
}

// Also export default for flexibility
export default Section;
