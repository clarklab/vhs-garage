const GARAGES = [
  {
    id: 'manchester-01',
    name: 'Manchester Garage 01',
    images: {
      light: '/images/bg-manchester-01.webp',
      dark: '/images/bg-manchester-01-dark.webp',
    },
  },
  {
    id: 'manchester-02',
    name: 'Manchester Garage 02',
    images: {
      light: '/images/bg-manchester-02.webp',
      dark: '/images/bg-manchester-02-dark.webp',
    },
  },
  {
    id: 'munozj145-01',
    name: 'munozj145 from r/VHS',
    images: {
      light: '/images/bg-munozj145-01.webp',
      dark: '/images/bg-munozj145-01-dark.webp',
    },
  },
  {
    id: 'vintage-sony-01',
    name: 'Vintage Sony',
    images: {
      light: '/images/bg-vintage-sony-01.webp',
      dark: '/images/bg-vintage-sony-01-dark.webp',
    },
  },
];

const BASE = 'https://vhsgarage.com';

const output = {
  _info: 'VHS Garage — garage background images for agents. Each garage has a light and dark variant (WebP with alpha transparency for the TV screen cutout). Prepend the base URL to image paths to get the full URL.',
  _base: BASE,
  _submit: 'To submit a new garage, visit https://vhsgarage.com/submit',
  garages: GARAGES.map(g => ({
    id: g.id,
    name: g.name,
    light: BASE + g.images.light,
    dark: BASE + g.images.dark,
  })),
};

export default async () => {
  return new Response(JSON.stringify(output, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
};
