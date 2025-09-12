import React from 'react';
export function Container({children, className=""}:{children: React.ReactNode, className?: string}){
  return <div className={`mx-auto w-full max-w-7xl px-4 md:px-6 ${className}`}>{children}</div>;
}
