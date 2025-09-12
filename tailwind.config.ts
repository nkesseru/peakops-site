/* Helpers */
.glass {
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  background: var(--fog);
  border: 1px solid var(--border);
  box-shadow: var(--shadow);
}

.round-24 { border-radius: 24px; }
.round-12 { border-radius: 12px; }

/* Typography scale */
.h1 { font-size: 32px; font-weight: 600; letter-spacing: -0.5px; }
.h2 { font-size: 22px; font-weight: 600; }
.p  { font-size: 15px; color: var(--text-secondary); }

/* Button base */
.btn { display:inline-flex; align-items:center; gap:10px; padding:12px 18px; border-radius:24px; transition: all .2s ease; }
.btn:hover { transform: translateY(-2px); }
.btn:active { transform: scale(0.98); }
.btn-primary { background: var(--teal); color: #0B0F14; }
.btn-secondary { background: var(--gold); color: #0B0F14; }
.btn-glass { background: var(--card); border:1px solid var(--border); color: var(--text-primary); }

// ======================= tailwind.config.ts =======================
/* Minimal example – extend as needed */
export default {
  darkMode: ["class"],
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        ink: "var(--ink)",
        graphite: "var(--graphite)",
        teal: "var(--teal)",
        gold: "var(--gold)",
        text: {
          primary: "var(--text-primary)",
          secondary: "var(--text-secondary)",
        },
      },
      borderRadius: {
        'xl': '24px',
        'lg': '12px',
      },
      boxShadow: {
        soft: "var(--shadow)",
      }
    }
  },
  plugins: [],
} satisfies import('tailwindcss').Config
