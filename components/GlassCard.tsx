import React from 'react';
export function GlassCard({children, className=""}:{children: React.ReactNode, className?: string}){
  return <div className={`glass round-24 p-6 ${className}`}>{children}</div>;
}
