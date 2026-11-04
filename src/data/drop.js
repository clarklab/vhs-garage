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
  // Where the drop lives. public/_redirects serves /drops/ at its root.
  url: 'https://drops.vhsgarage.com',
  // Selling through AI shopping agents (Stripe Agentic Commerce Suite).
  agent: {
    sku: 'VG-DROP-001',
    title: 'VHS Garage Originals Drop #001, Mystery VHS Tape',
    description:
      "An original VHS tape from VHS Garage, sold sight unseen: the title stays censored until drop day. One run, no restocks. When they're gone, they're gone.",
    image: '/images/drops/agent-product.png',
    // How long an agent's approved order holds its copy while Stripe charges.
    holdMinutes: 15,
    // Stripe Tax product tax code, once tax is set up for agent sales.
    taxCode: null,
  },
};
