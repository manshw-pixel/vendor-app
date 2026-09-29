/** Decorative only: every tab also shows its label, so these carry aria-hidden. */
const P: Record<string, string> = {
  "/bill": "M6 3h12v18l-3-2-3 2-3-2-3 2V3zm3 5h6M9 12h6",
  "/pending": "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z",
  "/completed": "M5 13l4 4L19 7",
  "/dues": "M7 5h10M7 9h10M7 5c5 0 5 8 0 8l8 6",
  "/customers": "M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0zM4 21c0-4 4-6 8-6s8 2 8 6",
  "/requests": "M4 5h16v11H8l-4 4V5z",
  "/stock": "M3 7l9-4 9 4-9 4-9-4zm0 0v10l9 4 9-4V7",
  "/close": "M12 3v9M5.6 7.6a8 8 0 1 0 12.8 0",
  "/outbox": "M4 14l8-8 8 8M12 6v14",
  more: "M5 12h.01M12 12h.01M19 12h.01",
};

export function NavIcon({ name }: { name: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="w-6 h-6" fill="none"
         stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d={P[name] ?? P.more} />
    </svg>
  );
}
