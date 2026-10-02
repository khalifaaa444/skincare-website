# Pétale — peony skincare website

A one-page luxury skincare site: a full-screen film behind the page is scrubbed by scroll
(a peony bud opens, a crystal jar rises out of it, the cap lifts off and the camera ends looking
down into the cream), with the story told in five short scenes, a four-piece product line, a
slide-in bag and a three-step demo checkout with a live 3D card.

Static HTML, CSS and plain JavaScript. No framework and no build step.

## Run it

Any static file server works. From this folder:

```sh
python3 -m http.server 8080
# or
npx serve .
```

Then open <http://localhost:8080>. Opening `index.html` straight from disk also works, but the
browser blocks the film probe and the page falls back to the drawn film.

## What's where

| Path | What it is |
| --- | --- |
| `index.html` | All the copy and markup |
| `assets/css/site.css` | Design tokens (`:root`), layout, type, phone layout |
| `assets/js/config.js` | Brand, products, prices, currency, shipping, film source |
| `assets/js/site.js` | Smooth scroll (Lenis), reveals, loading veil, progress bar |
| `assets/js/film/player.js` | Maps scroll to film progress and drives the film |
| `assets/js/film/scene-2d.js` | The built-in procedural film, drawn live on a canvas |
| `assets/js/film/frames.js` | Plays your own footage as an image sequence instead |
| `assets/js/checkout.js`, `assets/css/checkout.css` | Bag and checkout |
| `assets/img/products/*.svg` | Product illustrations |
| `tools/build-film.sh` | Turns your own video into frames for the film |
| `film/` | Where your film frames go (see `film/README.md`) |
| `dev/` | Test pages for each part (film, engine, products, checkout) |

## Make it yours

- **Brand name.** Replace `Pétale` / `PÉTALE` in `index.html` and `brand`/`logo` in
  `assets/js/config.js`.
- **Products and prices.** Edit `products` in `assets/js/config.js` (the bag and checkout read
  them from there), then update the matching cards and the hero button in `index.html`.
- **Currency and shipping.** `currency`, `freeShippingFrom`, `standardFee` and `shipping` in
  `config.js`.
- **Colours and fonts.** The tokens at the top of `assets/css/site.css` (`--air`, `--ink`,
  `--violet`, `--serif`, `--sans`, …).
- **Product photos.** Swap the SVGs in `assets/img/products/` for your own 4:5 images (WebP or
  JPEG, about 1000×1250) and update the `img` paths in `config.js` and `index.html`.
- **Your own film.** Render or shoot a 16:9 and a 9:16 clip that follow the five beats, then
  run `tools/build-film.sh --desktop clip-16x9.mp4 --portrait clip-9x16.mp4`. The site uses it
  automatically once `film/manifest.json` exists. Details: [`film/README.md`](film/README.md).

## Before you go live

- **Payments.** The checkout is a demo: it validates the form and animates the card, but charges
  nothing and sends nothing. For a real store, connect a payment provider's hosted checkout
  (Stripe, Paymob, Shopify, …) at the `Pay` step in `assets/js/checkout.js`, and never handle
  raw card numbers on your own page.
- **Footer links.** Terms, Privacy, Shipping & returns and the other footer links point to `#`;
  link them to real pages.
- **Images and copy** are original placeholders. Replace them with your own photography and
  wording.

## Credits

The layout, palette and scroll-film pattern follow the "Pivoine" concept site by Ascenta Studio
(ascentatrack.com/pivoine). This is an independent build: the code, text and artwork here were
written from scratch. Fonts: Playfair Display and Manrope (SIL Open Font License) via Google
Fonts. Smooth scrolling: [Lenis](https://github.com/darkroomengineering/lenis) (MIT,
`assets/vendor/lenis.LICENSE`).
