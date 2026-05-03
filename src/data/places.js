// Source of truth for every IRL location the places page should list.
// Thrift shops, record stores, swap meets, video stores, anywhere we
// recommend people go in person.
//
// HOW TO ADD A PLACE
//   1. Save the location image to /public/images/places/{slug}.webp
//   2. Add an entry below
//   3. (Optional) Reference it from any blog post with:
//        <PlaceCard slug="antones-record-shop" />
//      PlaceCard.astro looks up the rest from this file. Inline props
//      override anything in here, same pattern as AmazonCard / gear.js.
//
// FIELDS
//   slug        Required. Unique identifier — used for URL anchors and
//               component lookups. Lowercase + hyphens.
//   name        The business / location name as the world knows it.
//   description 1-3 short sentences. What's there, what's the vibe.
//   eyebrow     Small label above the name (e.g. "Record store",
//               "Thrift shop", "Swap meet"). Defaults to "Place".
//   image       Path to the self-hosted location photo, e.g.
//               "/images/places/antones-record-shop.webp".
//   certified   Boolean. true = we've actually been there and stand
//               behind it. The /places page floats certified spots to
//               the top and the card gets a green "✓ Garage Certified"
//               badge.
//   address     Street address, formatted however reads cleanest.
//   city        "Austin, TX" / "Brooklyn, NY" / etc.
//   mapsUrl     Optional explicit Google Maps URL (use when you want
//               to point at a specific business pin). If absent, the
//               component auto-builds a Maps search URL from
//               name + address + city.
//   website     Optional business website URL. Renders a secondary
//               "Visit website" button when present.
//
// Cards in posts that don't reference a places.js entry (just pass
// inline props to PlaceCard) still work — they just won't appear on
// the /places page.

export const PLACES = [
  // Add entries here as places come up. Example:
  //
  // {
  //   slug: 'antones-record-shop',
  //   name: "Antone's Record Shop",
  //   description: 'Vinyl, cassettes, the occasional VHS. Run by music nerds since 1987.',
  //   eyebrow: 'Record store',
  //   image: '/images/places/antones-record-shop.webp',
  //   certified: true,
  //   address: '2928 Guadalupe St',
  //   city: 'Austin, TX',
  //   website: 'https://antonesrecordshop.com',
  // },
];

// Lookup helper used by PlaceCard.astro. Slug match is case-insensitive
// so '<PlaceCard slug="ANTONES-RECORD-SHOP" />' still hits the entry.
export function findPlace(slug) {
  if (!slug) return null;
  const needle = String(slug).trim().toLowerCase();
  return PLACES.find((p) => String(p.slug).toLowerCase() === needle) || null;
}

// Build a Google Maps search URL from a place's name + address. Used
// when the place doesn't have an explicit `mapsUrl`. The
// /maps/search/?api=1&query= format opens directly in the Maps app on
// mobile and the maps.google.com site on desktop.
export function buildMapsUrl(place) {
  if (!place) return 'https://www.google.com/maps';
  if (place.mapsUrl) return place.mapsUrl;
  const parts = [place.name, place.address, place.city].filter(Boolean);
  const query = encodeURIComponent(parts.join(', '));
  return `https://www.google.com/maps/search/?api=1&query=${query}`;
}
