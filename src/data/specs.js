// Spec sheets rendered at /docs/<id>. Deliberately minimal — these go to
// the printer and to partners, and a short sheet gets read.
//
// Fuller versions of this data (press settings, garment-dye notes, size
// measurements, approval gates) are in git history at rev C if we ever
// need them back.

export const SPECS = [
  {
    id: 'leatherface',
    docNo: 'VHSG-APP-001',
    rev: 'D',
    title: 'Leatherface',
    subtitle: 'Screenprint Spec',
    issued: '2026-08-16',

    // The art is white on transparent, so it needs a dark plate behind it
    // on this white sheet — see `dark` below.
    art: {
      href: '/images/docs/leatherface/leatherface-print-file-white.png',
      label: 'Art file',
      note: 'One screen, one pull',
      dark: true,
    },
    preview: {
      href: '/images/docs/leatherface/leatherface-preview-tee-gradient.png',
      label: 'On the shirt',
      note: 'Mockup, not to scale',
    },

    facts: [
      ['Print', '5 in wide — center chest'],
      ['Shirt', 'Comfort Colors 1717 — Black'],
      ['Ink', 'Split fountain — neon orange into neon pink'],
    ],

    // Split fountain (a.k.a. rainbow roll): both inks are loaded side by
    // side in the same screen and blend under a single pull.
    inkNote:
      'Two inks, one screen, one pull. The blend shifts a little every pull, so no two shirts come out identical — that is the point.',

    // qty/unit are numbers so the page computes the totals — no hand-math
    // that can drift out of sync with the line items.
    sizes: [
      { size: 'S', qty: 3, unit: 6.87 },
      { size: 'M', qty: 7, unit: 6.87 },
      { size: 'L', qty: 7, unit: 6.87 },
      { size: 'XL', qty: 5, unit: 6.87 },
      { size: '2XL', qty: 3, unit: 10.44 },
    ],

    // Everything downstream of this (cost per shirt, profit) is computed on
    // the page from these three numbers plus the size run.
    money: {
      printingFee: 150,
      printer: 'Julia',
      sellPrice: 30,
    },
  },
];

export const getSpec = (id) => SPECS.find((s) => s.id === id);
