// The next VHS Garage Original. One run, no restocks — the page counts down
// to `opensAt` and the tape stays mosaicked until then. Before `opensAt`,
// buying is a pre-order; after, it's a sale. Both draw on the same stock.
//
// Read by both the /drops page and the drop-* Netlify functions, so the
// price shown is the price charged.
export const DROP = {
  id: '001',
  number: '001',
  opensAt: '2026-11-20T12:00:00-06:00',
  opensLabel: 'Fri, Nov 20 · 12 PM CT',
  // Never shown on the page — "one run" is the pitch, not the count.
  quantity: 6,
  price: 24,
  shipping: 6,
  // How long a copy is held for someone sitting in checkout.
  holdMinutes: 10,
  name: 'VHS Garage Originals — Drop 001',
};
