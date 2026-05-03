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
//               affiliate-tagged URL or a different storefront.
//
// Cards in posts that don't reference a gear.js entry (i.e. just pass
// `url`/`title` directly to AmazonCard) still work — they just won't
// appear on the /gear page.

export const GEAR = [
  // Add entries here as products come up. Example:
  //
  // {
  //   asin: 'B07XYZ1234',
  //   title: 'Panasonic PV-V4520 VHS VCR',
  //   description: 'A solid 4-head hi-fi machine with the EP-mode tracking that keeps long-play tapes from looking blurry.',
  //   eyebrow: 'Recommended VCR',
  //   image: '/images/gear/panasonic-pv-v4520.webp',
  //   certified: true,
  // },
];

// Helper used by AmazonCard.astro to do an ASIN lookup. Case-insensitive.
export function findGear(asin) {
  if (!asin) return null;
  const needle = String(asin).trim().toUpperCase();
  return GEAR.find((g) => String(g.asin).toUpperCase() === needle) || null;
}
