/**
 * Colour families for a catalogue whose colours live only in the product
 * name suffix ("– Marigold Ember"). Matching is on whole words of that
 * suffix, so "Skyline Slate" is grey (slate), not blue (sky).
 *
 * A shade can sit in more than one family ("Harvest Gold" is orange and
 * yellow); that only widens matches, it never hides a product.
 */
export const COLOR_FAMILIES: Record<string, string[]> = {
  orange: [
    'orange', 'marigold', 'ember', 'terra', 'terracotta', 'peach', 'clay',
    'amber', 'ochre', 'autumn', 'sunset', 'harvest', 'rust', 'apricot',
    'coral', 'copper', 'tangerine', 'saffron',
  ],
  pink: ['pink', 'blush', 'rose', 'rosewood', 'orchid', 'petal', 'fuchsia', 'magenta'],
  blue: [
    'blue', 'azure', 'ocean', 'oceanic', 'sky', 'aqua', 'indigo', 'aegean',
    'navy', 'cobalt', 'denim', 'seaside',
  ],
  teal: ['teal', 'turquoise', 'aqua'],
  green: ['green', 'sage', 'celadon', 'mint', 'olive', 'emerald', 'moss', 'jade', 'leaf'],
  grey: [
    'grey', 'gray', 'graphite', 'slate', 'charcoal', 'stone', 'silver',
    'ashen', 'ash', 'dove', 'smoke', 'pewter',
  ],
  white: ['white', 'ivory', 'cream', 'pearl', 'snow'],
  beige: ['beige', 'sand', 'dune', 'taupe', 'greige', 'mushroom', 'oat', 'linen', 'nude'],
  purple: ['purple', 'violet', 'lilac', 'mulberry', 'nightshade', 'lavender', 'plum', 'mauve', 'orchid'],
  yellow: ['yellow', 'gold', 'golden', 'ochre', 'marigold', 'mustard', 'harvest', 'saffron', 'honey', 'lemon'],
  red: ['red', 'merlot', 'crimson', 'burgundy', 'maroon', 'wine', 'ruby', 'rust'],
  black: ['black', 'noir', 'charcoal', 'ebony', 'onyx'],
  brown: ['brown', 'mocha', 'chocolate', 'coffee', 'walnut', 'cocoa', 'chestnut'],
  multi: ['pastels', 'multi', 'multicolour', 'multicolor', 'rainbow'],
}

/** Display label used in prompt facts ("orange tones"). */
export const COLOR_FAMILY_LABEL: Record<string, string> = {
  orange: 'Orange / terracotta tones',
  pink: 'Pink / blush tones',
  blue: 'Blue tones',
  teal: 'Teal tones',
  green: 'Green / sage tones',
  grey: 'Grey / slate tones',
  white: 'White / ivory tones',
  beige: 'Beige / neutral tones',
  purple: 'Purple / violet tones',
  yellow: 'Yellow / gold tones',
  red: 'Red / wine tones',
  black: 'Black tones',
  brown: 'Brown tones',
  multi: 'Multi-colour',
}

/** Families whose words appear in a colour name, in `COLOR_FAMILIES` order. */
export function colorFamiliesOf(colorName: string | null | undefined): string[] {
  if (!colorName) return []
  const words = new Set(
    colorName
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter(Boolean),
  )
  const out: string[] = []
  for (const [family, needles] of Object.entries(COLOR_FAMILIES)) {
    if (needles.some((n) => words.has(n))) out.push(family)
  }
  return out
}
