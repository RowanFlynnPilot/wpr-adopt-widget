/**
 * Wausau Pilot & Review — Adopt-a-Pet Widget Embed Script
 *
 * Usage:
 *   <div id="wpr-adopt-widget"></div>
 *   <script src="https://rowanflynnpilot.github.io/wpr-adopt-widget/embed.js"></script>
 *
 * Options (via data attributes on the script tag):
 *   data-container="myId"  — target a different container element
 *   data-max-width="1200"  — set max-width in pixels (default: 1200)
 */
(function () {
  'use strict';

  var WIDGET_URL = 'https://rowanflynnpilot.github.io/wpr-adopt-widget/adopt-widget.html';

  // Find the script tag to read data attributes
  var scripts = document.getElementsByTagName('script');
  var thisScript = scripts[scripts.length - 1];
  var containerId = thisScript.getAttribute('data-container') || 'wpr-adopt-widget';
  var maxWidth = thisScript.getAttribute('data-max-width') || '1200';

  // Find or create container
  var container = document.getElementById(containerId);
  if (!container) {
    container = thisScript.parentElement;
  }

  // Create iframe
  var iframe = document.createElement('iframe');
  iframe.src = WIDGET_URL;
  iframe.title = 'Adoptable Pets — Central Wisconsin Shelters';
  iframe.loading = 'lazy';
  iframe.setAttribute('allowtransparency', 'true');
  iframe.style.cssText = [
    'width:100%',
    'border:none',
    'min-height:600px',
    'max-width:' + maxWidth + 'px',
    'margin:0 auto',
    'display:block',
    'background:transparent'
  ].join(';');

  container.appendChild(iframe);

  // Listen for messages from the widget
  window.addEventListener('message', function (e) {
    if (!e.data) return;
    // Auto-resize iframe height
    if (e.data.type === 'wpr-adopt-widget-resize' && typeof e.data.height === 'number') {
      iframe.style.height = e.data.height + 'px';
    }
  });
})();
