'use client';
import {useTheme} from 'next-themes';
import {Moon, Sun} from 'lucide-react';
export function ThemeToggle(){
  const {theme, setTheme, resolvedTheme} = useTheme();
  const isDark = resolvedTheme === 'dark';
  return (
    <button aria-label="Toggle theme" className="btn btn-glass" onClick={()=> setTheme(isDark? 'light':'dark')}>
      {isDark ? <Sun className="w-4 h-4"/> : <Moon className="w-4 h-4"/>}
      <span className="hidden sm:inline">{isDark? 'Light':'Dark'} mode</span>
    </button>
  );
}
