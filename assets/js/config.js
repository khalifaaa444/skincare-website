/* Site configuration — brand, catalogue, shipping and the scroll-film source.
   Everything the page, the film and the checkout read lives here, so a rebrand or a
   price change is an edit to this one file (plus the static copy in index.html). */
window.SITE = {
  brand: "Pétale",
  logo: "PÉTALE",
  tagline: "Peony skincare",

  currency: { code: "USD", symbol: "$", locale: "en-US" },

  /* free standard shipping at or above this subtotal; below it, standard costs `standardFee` */
  freeShippingFrom: 100,
  standardFee: 8,
  shipping: [
    { id: "standard", label: "Complimentary delivery", detail: "3–5 business days", price: 0 },
    { id: "express", label: "Express", detail: "1–2 business days", price: 18 }
  ],

  products: [
    {
      sku: "cream",
      name: "Peony Renewal Cream",
      short: "Renewal Cream",
      note: "Peony · Hyaluronic acid",
      size: "50 ml",
      price: 124,
      img: "assets/img/products/cream.svg",
      alt: "Peony Renewal Cream, a wide crystal jar with a plum lacquer cap"
    },
    {
      sku: "serum",
      name: "Peony Morning Serum",
      short: "Morning Serum",
      note: "Peony · Niacinamide",
      size: "30 ml",
      price: 92,
      img: "assets/img/products/serum.svg",
      alt: "Peony Morning Serum, a tall crystal dropper bottle"
    },
    {
      sku: "eye",
      name: "Peony Eye Balm",
      short: "Eye Balm",
      note: "Peony · Caffeine",
      size: "15 ml",
      price: 68,
      img: "assets/img/products/eye.svg",
      alt: "Peony Eye Balm, a small crystal pot with a plum lacquer cap"
    },
    {
      sku: "oil",
      name: "Peony Night Oil",
      short: "Night Oil",
      note: "Peony · Rosehip",
      size: "30 ml",
      price: 84,
      img: "assets/img/products/oil.svg",
      alt: "Peony Night Oil, a round crystal flacon of rose-pink oil"
    }
  ],

  /* The full-screen film behind the page, scrubbed by scroll.
     source: "auto"   — use the image-sequence film in film/manifest.json if it exists,
                         otherwise the procedural scene below
             "frames" — image sequence only
             "scene"  — procedural scene only */
  film: {
    source: "auto",
    manifest: "film/manifest.json",
    scene: "scene2d"
  }
};
