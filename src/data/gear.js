// Source of truth for every Amazon product the gear page should list.
//
// HOW TO ADD A NEW PRODUCT
//   1. Find the ASIN on Amazon (10-char string after /dp/ or /gp/product/
//      in the URL — e.g. https://www.amazon.com/.../dp/B07XYZ1234/)
//   2. Save the product image to /public/images/gear/{descriptive-name}.webp
//   3. Add an entry below
//   4. (Optional) Reference it from any blog post with:
//        <AmazonCard asin="B07XYZ1234" />
//      AmazonCard.astro looks up the rest from this file. You can still
//      override any field inline if needed:
//        <AmazonCard asin="B07XYZ1234" eyebrow="Our top pick" />
//
// FIELDS
//   asin        Required. The Amazon Standard Identification Number.
//   title       Display title for the product (we control the wording,
//               not Amazon's listing title).
//   description Plain text, ~1-3 short sentences.
//   eyebrow     Small label above the title (e.g. "Recommended VCR",
//               "Best budget pick"). Defaults to "Recommended gear".
//   image       Path to the self-hosted product photo, e.g.
//               "/images/gear/foo.webp". Don't hotlink Amazon's CDN —
//               their URLs rotate and it's against the affiliate ToS.
//   certified   Boolean. true = we've used and stand behind it; the
//               /gear page floats certified items to the top and the
//               card gets a green "✓ Garage Certified" badge.
//   url         Optional override. By default we link to
//               https://www.amazon.com/dp/{asin}; pass `url` to use an
//               affiliate-tagged URL, an a.co short URL, or a different
//               storefront. When passed, this URL is used directly and
//               the asin field becomes a synthetic key for lookups.
//   priceRange  Optional historical/typical price band (e.g. "$10–20").
//               Rendered as a "Usually $10–20" pill on the card so it
//               reads as "we've seen this go for" — NOT a quote of the
//               current Amazon price (which changes constantly and
//               which we don't track).
//
// Cards in posts that don't reference a gear.js entry (i.e. just pass
// `url`/`title` directly to AmazonCard) still work — they just won't
// appear on the /gear page.

export const GEAR = [
  {
    // a.co short URLs don't expose a real ASIN to scrape; we use the
    // short URL's path fragment as a synthetic key. Lookup happens
    // by exact string match against the `asin` field — works the same
    // either way.
    asin: '0IYXKQIS',
    url: 'https://a.co/d/0iyxKQiS',
    title: 'USB Video Capture Card (RCA + S-Video)',
    description: "The cheap dongle that turns your VCR into a webcam. Plug in RCA cables, plug in USB, your computer sees it as a video device. Works with VHS Garage, OBS, QuickTime, anything that records. Don't overthink this — they're all basically the same.",
    eyebrow: 'Recommended hardware',
    image: '/images/gear/usb-capture-device.webp',
    certified: true,
    priceRange: '$10–20',
  },
];

// Helper used by AmazonCard.astro to do an ASIN lookup. Case-insensitive.
export function findGear(asin) {
  if (!asin) return null;
  const needle = String(asin).trim().toUpperCase();
  return GEAR.find((g) => String(g.asin).toUpperCase() === needle) || null;
}
