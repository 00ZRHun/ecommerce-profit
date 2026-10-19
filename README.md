# Profit Growth Coaching — landing page

A responsive, single-page marketing site built from the supplied reference image. No framework or build step — open it with any static server.

## Run it

```bash
cd /Users/zuronghun/Desktop/Coding/testimonial
python3 -m http.server 4173
```

Then open <http://127.0.0.1:4173>.

You can also open `index.html` directly, though a local server is recommended for consistent font/image loading.

## What's included

- `index.html` — the full landing page
- `styles.css` — design system, layout, motion and responsive rules
- `script.js` — navigation, reveals, counters, calculator, form wizard, FAQ and newsletter
- `legal.html` — privacy policy and terms template
- `assets/` — founder portrait and favicon
- `funnels/` — the original design reference image (not used by the site)

## Improvements over the reference

- **Responsive layout** from 320px phones through wide desktops, including a proper mobile navigation drawer.
- **Working two-step audit form** with validation, inline errors, keyboard focus management, a success state and accessible descriptions.
- **Interactive profit calculator** modal (nav, results section and footer) with revenue/margin sliders, live estimates and a 3× valuation view.
- **Animated proof** — counters, a chart that draws on scroll, scroll reveals and a pulsing live indicator.
- **Accessible FAQ accordion** with `aria-expanded`, `aria-controls` and animated answers.
- **Newsletter form** with email validation and a success state.
- **SEO and sharing basics** — meta description, Open Graph tags, JSON-LD service/offer schema and a favicon.
- **Accessibility details** — skip link, semantic landmarks, focus-visible styles, reduced-motion support and an anti-flicker fallback if JS fails.
- **Polished extras** — custom hand-built SVG icon set, founder-led trust note, “what happens next” checklist, legal page and dynamic copyright year.

## Notes / customization

- The **audit form and newsletter are front-end demos**. They validate and show success states, but do not send data anywhere. Connect the `submit` handlers in `script.js` to your CRM, form endpoint or email provider.
- Replace `assets/founder.jpg` with a real founder/coach portrait when available. The current image is a placeholder from Unsplash.
- Case-study metrics and testimonial-style proof points are illustrative. Replace them with verified numbers before publishing.
- The calculator is an estimate only; the formula is in `updateCalculator()` in `script.js`.
- Brand colors, radii, spacing and fonts are defined as CSS custom properties at the top of `styles.css`.

## QA

- Checked at 320, 390, 768, 1024 and 1440px with no horizontal overflow.
- Zero axe-core WCAG 2.1 A/AA violations on the landing and legal pages, in mobile and desktop viewports, including form errors and the calculator dialog.
- If JavaScript fails to load, content remains visible; only the enhancement animations are disabled.
# ecommerce-profit
