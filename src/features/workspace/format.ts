export const pct = (p: number, d = 1) => `${(p * 100).toFixed(d)}%`;
/** Probability with enough precision to stay readable when small. */
export const prob = (p: number) => (p === 0 ? '0' : p < 1e-4 ? p.toExponential(1) : pct(p, p < 0.01 ? 2 : 1));
export const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Edmonton' });
