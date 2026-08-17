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
    rev: 'F',
    title: 'Leatherface',
    subtitle: 'Screenprint Spec',
    issued: '2026-08-16',

    // The art itself. `display` is white on transparent so it needs a dark
    // plate behind it on this white sheet; `files` are the real downloads
    // for anyone who wants to open the actual separation.
    art: {
      display: '/images/docs/leatherface/leatherface-print-file-white.png',
      files: [
        {
          name: 'leatherface-print-file.png',
          href: '/images/docs/leatherface/leatherface-print-file.png',
          size: '400 × 217',
          what: 'Standard',
        },
        {
          name: 'leatherface-print-file-large.png',
          href: '/images/docs/leatherface/leatherface-print-file-large.png',
          size: '1600 × 868',
          what: 'Full size',
        },
      ],
    },

    // The two ways we can run it. Same screen, same art — the difference is
    // what goes in the ink well.
    options: [
      {
        key: 'A',
        title: 'Gradient pull',
        href: '/images/docs/leatherface/leatherface-preview-tee-gradient.png',
        ink: 'Orange to pink',
        note: 'Split fountain. Orange up top, pink down low. Every one comes out a little different.',
      },
      {
        key: 'B',
        title: 'Normal pull',
        href: '/images/docs/leatherface/leatherface-preview-tee.png',
        ink: 'Rusty orange',
        note: 'Single ink, straight pull. Every shirt comes out the same.',
      },
    ],

    facts: [
      ['Print', '5 in wide — center chest'],
      ['Shirt', 'Comfort Colors 1717 — Black'],
      ['Screens', 'One either way — same art, same pull'],
    ],

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
