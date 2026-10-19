/* Dev-only harness for visual checks.
 *
 * Renders the site inside a same-origin iframe at a chosen CSS viewport width
 * so real media queries apply, then clips to an exact window so a full-page
 * screenshot of this harness is a pixel-exact slice of the site.
 *
 * The iframe is made deliberately tall (so the whole page lays out and every
 * scroll-triggered reveal fires) and shifted up by `y` inside an overflow
 * hidden box. No inner scrolling is involved, so captures are deterministic.
 *
 *   ?w=390     iframe CSS width (default 390)
 *   &h=844     visible slice height (default 900)
 *   &y=1200    slice offset from the top of the page (default 0)
 *   &fh=20000  forced iframe height (default 20000)
 *   &path=/    page to render
 */
(function () {
  var params = new URLSearchParams(location.search);
  var width = parseInt(params.get('w') || '390', 10);
  var height = parseInt(params.get('h') || '900', 10);
  var offsetY = parseInt(params.get('y') || '0', 10);
  var frameHeight = parseInt(params.get('fh') || '20000', 10);
  var path = params.get('path') || '/';
  var clip = document.getElementById('clip');
  var frame = document.getElementById('frame');

  clip.style.width = width + 'px';
  clip.style.height = height + 'px';
  frame.style.width = width + 'px';
  frame.style.height = frameHeight + 'px';
  frame.style.top = (-offsetY) + 'px';
  frame.src = path;

  function revealAll() {
    try {
      var doc = frame.contentDocument;
      if (!doc || doc.getElementById('harness-reveal')) return;
      var style = doc.createElement('style');
      style.id = 'harness-reveal';
      style.textContent =
        '[data-reveal],[data-reveal].is-visible{opacity:1!important;transform:none!important;' +
        'transition:none!important;animation:none!important}';
      doc.head.appendChild(style);
    } catch (error) { /* ignore */ }
  }

  function report() {
    revealAll();
    try {
      var doc = frame.contentDocument;
      var full = Math.max(
        doc.documentElement.scrollHeight,
        doc.body ? doc.body.scrollHeight : 0
      );
      document.title = 'w=' + width + ' y=' + offsetY + ' full=' + full;
    } catch (error) { /* ignore */ }
  }

  frame.addEventListener('load', function () {
    report();
    try {
      frame.contentWindow.document.fonts.ready.then(report);
    } catch (error) { /* ignore */ }
    setTimeout(report, 400);
    setTimeout(report, 1200);
    setTimeout(report, 2400);
  });
})();
