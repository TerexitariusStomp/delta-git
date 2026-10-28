// The deployment's brand, stamped into index.html by the worker as
// <meta name="dg-brand"> (src/shared/brand.ts). Without it (local dev, tests)
// the SPA shows the default Widespread brand.
export interface Brand {
  name: string
  tagline: string
  logo: string
}

const DEFAULT_BRAND: Brand = { name: 'Widespread', tagline: 'Code forge', logo: '/logo-widespread.png' }

let cached: Brand | undefined

export function getBrand(): Brand {
  if (cached) return cached
  if (typeof document === 'undefined') return DEFAULT_BRAND
  const raw = document.querySelector('meta[name="dg-brand"]')?.getAttribute('content')
  let brand = DEFAULT_BRAND
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === 'object') {
      const { name, tagline, logo } = parsed as Partial<Record<keyof Brand, unknown>>
      if (typeof name === 'string' && typeof logo === 'string') {
        brand = { name, logo, tagline: typeof tagline === 'string' ? tagline : DEFAULT_BRAND.tagline }
      }
    }
  } catch {
    // Malformed meta: keep the default rather than break the shell.
  }
  cached = brand
  return brand
}
