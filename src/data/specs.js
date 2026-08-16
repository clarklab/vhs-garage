// Apparel spec sheets rendered at /docs/<id>.
//
// These are the docs we hand to the screenprinter and to biz partners, so
// every value here ends up in front of someone who will act on it. Anything
// we haven't nailed down yet is written as the literal string 'TBD' — the
// spec page renders TBD in red so nothing unconfirmed slips past a reader.
//
// Asset paths point at /public. If a file isn't there yet the page draws an
// "AWAITING ASSET" plate with the expected path, so the doc is still usable
// and it's obvious what's missing.

export const SPECS = [
  {
    id: 'leatherface',
    docNo: 'VHSG-APP-001',
    rev: 'C',
    title: 'Leatherface',
    subtitle: 'Screenprint Production Specification',
    status: 'DRAFT — FOR PRINTER REVIEW',
    issued: '2026-08-16',
    preparedBy: 'C. Wimberly',
    program: 'VHS Garage / Apparel Division',
    classification: 'INTERNAL — VENDOR RELEASE',
    summary:
      'One-color white print on a black garment-dyed heavyweight tee. Art is a 1-bit dither — white dots on bare shirt. Limited drop, 25 pieces. This sheet is the single source of truth for artwork, placement, ink, and size run — print from it, quote from it, approve from it.',

    // Files the printer needs. `href` is served from /public.
    assets: {
      // The press-ready file. The "-large" file is the 400px dither
      // upscaled 4x nearest-neighbour, so every dither dot is a crisp 4px
      // block — that is the one that goes to press, not the 400px original.
      printFile: {
        href: '/images/docs/leatherface/leatherface-print-file-large.png',
        label: 'Press-ready artwork',
        note: '1-bit dither · 1600 × 868 px · white = ink',
      },
      // Printed mockup. Its garment proportions do not match the real 1717,
      // so it must not be used to derive size — the drawing governs.
      preview: {
        href: '/images/docs/leatherface/leatherface-preview-tee.png',
        label: 'Preview — front',
        note: 'Illustrative. Not to scale, not for separation.',
      },
    },

    // Section 010
    artwork: [
      ['Art file', 'leatherface-print-file-large.png — 1-bit bitmap'],
      ['Pixel dimensions', '1600 × 868 px'],
      ['Image area', '5.5 in W × 2.98 in H'],
      ['Resolution at size', '291 DPI'],
      ['Polarity', 'WHITE = ink. BLACK = no ink, bare shirt.'],
      ['Color count', '1 (one) — white'],
      ['Halftones', 'NONE — art is pre-dithered. Do not screen it.'],
      ['Dither dot', '0.0138 in minimum (4 px) — approx. 73 LPI equivalent'],
      ['Underbase', 'None — direct white on black'],
      ['Trap / choke', 'N/A at 1 color'],
      ['Art scaling', 'Output at 100%. Do not resample or re-dither.'],
    ],

    // The three ways this specific file gets ruined on the way to press.
    artworkNotes: [
      'The art is already dithered to 1-bit. Running a halftone screen over it on output will moiré against the dither and turn the image to mud. Image the bitmap at 100% with no additional screening.',
      'Do not resample. Any resize must be nearest-neighbour at a whole-number multiple — interpolation smears the dots into grey and the file stops being 1-bit.',
      'leatherface-print-file.png (400 × 217) is the same dither at web resolution and is reference only. The file for press is leatherface-print-file-large.png.',
    ],

    // Section 020
    garment: [
      ['Blank', 'Comfort Colors 1717 Garment-Dyed Heavyweight'],
      ['Colorway', 'Black'],
      ['Fabric', '6.1 oz — 100% US ring-spun cotton'],
      ['Dye', 'Garment-dyed / soft-washed. Pre-shrunk.'],
      ['Fit', 'Relaxed — runs generous vs. standard retail fit'],
      ['Body', 'Tubular — NO side seams'],
      ['Neck', 'Ribbed crew, twill-taped neck and shoulders'],
      ['Hems', 'Double-needle collar and bottom hems'],
      ['Labeling', 'Keep manufacturer tag — no relabel this run'],
      ['Sourced from', 'BulkApparel'],
    ],

    // Called out on the sheet as a callout, not a table row — these are the
    // things that get a garment-dyed run rejected by someone who was
    // expecting a standard blank.
    garmentNotes: [
      'Shade varies piece to piece and lot to lot. That is inherent to garment dye, not a defect — do not reject the run over slight variation in the black.',
      'Pull all pieces from a single dye lot wherever possible. Mixed lots are visibly different side by side.',
      'Garment-dyed surfaces can carry loose pigment (crocking). Confirm ink adhesion on the strike-off before running the balance.',
    ],

    // Section 030 — mirrors the callouts in the technical drawing.
    placement: [
      ['Location', 'Front, center chest'],
      ['Print size', '5.5 in W × 2.98 in H'],
      ['Horizontal', 'Centered on body — align on neck center'],
      ['Vertical', 'TBD — 3.0 in below back collar seam proposed'],
      ['Tolerance', '± 0.25 in'],
      ['Same size all garments', 'Yes — 5.5 in on every size, S through 2XL'],
      ['Back print', 'None'],
      ['Sleeve print', 'None'],
    ],

    // Section 040
    ink: [
      {
        name: 'White',
        swatch: '#f4f2ec',
        pantone: 'Standard opaque white',
        type: 'Plastisol',
        mesh: '200',
        note: 'Opaque enough to read on black, thin enough to hold the dots',
      },
    ],

    // The single hardest call on this job, so it gets said out loud.
    pressNote:
      'Mesh is a trade-off on this print. The 0.0138 in dither dots want a high mesh; opaque white on a black garment wants a low one. 200 is the starting point, not the answer — prove BOTH dot hold and opacity on the strike-off before running the balance.',
    press: [
      ['Ink system', 'Plastisol, opaque white'],
      ['Mesh count', '200 recommended — 156 to 230 acceptable'],
      ['Squeegee', '70 duro, medium pressure'],
      ['Flash', 'Not required at 1 color'],
      ['Cure', '320 °F / 160 °C — verify with temp strip'],
      ['Hand feel', 'Soft. Reject heavy/plastic deposit.'],
    ],

    // Section 050 — measurements in inches, garment laid flat, from the
    // Comfort Colors published 1717 spec. qty/unit are numbers so the page
    // computes extensions and totals; nothing here is hand-math that can
    // drift out of sync with the line items.
    sizeRun: {
      note: 'Measurements are the Comfort Colors published 1717 spec. Quantities and blank pricing are the confirmed BulkApparel order. No 3XL in this run.',
      rows: [
        { size: 'S', length: '26.625', chest: '18.25', qty: 3, unit: 6.87 },
        { size: 'M', length: '28', chest: '20.25', qty: 7, unit: 6.87 },
        { size: 'L', length: '29.375', chest: '22', qty: 7, unit: 6.87 },
        { size: 'XL', length: '30.75', chest: '24', qty: 5, unit: 6.87 },
        { size: '2XL', length: '31.625', chest: '26', qty: 3, unit: 10.44 },
      ],
    },

    // Section 055 — what's known about cost. Blanks are locked; everything
    // the printer controls is still open.
    costing: {
      source: 'BulkApparel cart, 2026-08-16',
      printCost: 'TBD — printer to quote',
      screenCharge: 'TBD — printer to quote',
      note: '2XL carries a $3.57 upcharge over S–XL ($10.44 vs $6.87). Either price 2XL higher at retail or absorb it — decide before the drop goes live.',
    },

    // Section 060
    finishing: [
      ['Fold', 'Standard retail fold'],
      ['Bagging', 'Individual poly bag, size sticker on bag'],
      ['Cartons', 'Sorted by size, size marked on carton'],
      ['Ship to', 'TBD'],
    ],

    // Section 070
    approvals: [
      { item: 'Artwork approved', by: 'VHS Garage', state: 'PENDING' },
      { item: 'Strike-off / press proof', by: 'Printer', state: 'PENDING' },
      { item: 'Quantities + size run locked', by: 'VHS Garage', state: 'PENDING' },
      { item: 'Release to production', by: 'Both', state: 'PENDING' },
    ],

    revisions: [
      {
        rev: 'C',
        date: '2026-08-16',
        by: 'CW',
        note: 'Artwork received. Print size set to 5.5 in wide; height derives to 2.98 in from the file aspect. Polarity, dither dot size, and no-rescreen instruction specified. Mesh raised to 200 for dot hold. Printed mockup added — illustrative only, its garment proportions do not match the 1717. Vertical drop still to confirm.',
      },
      {
        rev: 'B',
        date: '2026-08-16',
        by: 'CW',
        note: 'Blank confirmed as Comfort Colors 1717 (was proposed Bella+Canvas 3001). Size run, quantities, and blank pricing locked from the BulkApparel order. Size chart replaced with published 1717 measurements. Art file still outstanding.',
      },
      { rev: 'A', date: '2026-08-16', by: 'CW', note: 'Initial release. Art file and quantities outstanding.' },
    ],
  },
];

export const getSpec = (id) => SPECS.find((s) => s.id === id);
