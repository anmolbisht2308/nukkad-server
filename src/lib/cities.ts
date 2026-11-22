/** Cities we operate in. Expansion = flip status and seed supply. */
export const CITIES = [
  { slug: "bareilly", name: "Bareilly", status: "live", center: [79.4304, 28.367] },
  { slug: "moradabad", name: "Moradabad", status: "launching", center: [78.7733, 28.8386] },
  { slug: "rampur", name: "Rampur", status: "coming_soon", center: [79.0257, 28.8154] },
  { slug: "shahjahanpur", name: "Shahjahanpur", status: "coming_soon", center: [79.9056, 27.8826] },
  { slug: "pilibhit", name: "Pilibhit", status: "coming_soon", center: [79.8047, 28.6315] },
] as const;

export type CitySlug = (typeof CITIES)[number]["slug"];
