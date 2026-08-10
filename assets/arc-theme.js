/* Oneliq theme switch - dark (default) / light.
 *
 * Must be loaded synchronously in <head>, before the stylesheet paints,
 * otherwise a light-theme visitor gets a navy flash on every navigation.
 * Deliberately dependency-free for that reason: no ARC, no ArcUI.
 */
(function (global) {
  'use strict';

  var KEY = 'oneliq.theme';
  var root = document.documentElement;

  function read() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }

  // Dark is the default: an unset (or corrupted) preference means dark, and
  // the OS setting is deliberately ignored so the site looks the same to
  // everyone who has never touched the switch.
  function current() {
    return read() === 'light' ? 'light' : 'dark';
  }

  function apply(theme) {
    if (theme === 'light') root.setAttribute('data-theme', 'light');
    else root.setAttribute('data-theme', 'dark');
  }

  function set(theme) {
    var next = theme === 'light' ? 'light' : 'dark';
    apply(next);
    try { localStorage.setItem(KEY, next); } catch (e) { /* private mode */ }
    syncButtons();
    global.dispatchEvent(new CustomEvent('arc:theme', { detail: { theme: next } }));
    return next;
  }

  function toggle() {
    return set(current() === 'light' ? 'dark' : 'light');
  }

  // Run immediately - before <body> exists, before the first paint.
  apply(current());

  var SUN = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true">'
    + '<circle cx="10" cy="10" r="3.6" fill="currentColor"/>'
    + '<g stroke="currentColor" stroke-width="1.7" stroke-linecap="round">'
    + '<path d="M10 1.6v2M10 16.4v2M18.4 10h-2M3.6 10h-2M15.94 4.06l-1.42 1.42M5.48 14.52l-1.42 1.42M15.94 15.94l-1.42-1.42M5.48 5.48L4.06 4.06"/>'
    + '</g></svg>';

  var MOON = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true">'
    + '<path d="M16.5 12.4A7 7 0 017.6 3.5a7 7 0 108.9 8.9z" fill="currentColor"/>'
    + '</svg>';

  function buttonHtml() {
    return '<button class="theme-toggle" type="button" role="switch"'
      + ' aria-checked="' + (current() === 'light') + '"'
      + ' aria-label="Switch between light and dark theme" title="Switch theme">'
      + '<span class="tt-ico tt-sun">' + SUN + '</span>'
      + '<span class="tt-ico tt-moon">' + MOON + '</span>'
      + '</button>';
  }

  function syncButtons() {
    var on = current() === 'light';
    var all = document.querySelectorAll('.theme-toggle');
    for (var i = 0; i < all.length; i++) all[i].setAttribute('aria-checked', String(on));
  }

  // Add the switch to a container unless one is already there. Used for the
  // hand-written navbars (home, blog, docs); the shared shell in arc-ui.js
  // renders its own copy inline so it survives a repaint.
  function mount(container) {
    if (!container || container.querySelector('.theme-toggle')) return;
    container.insertAdjacentHTML('afterbegin', buttonHtml());
  }

  // One delegated handler covers every switch on the page, however it got
  // there and however many times its container re-renders.
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('.theme-toggle');
    if (btn) { e.preventDefault(); toggle(); }
  });

  function autoMount() {
    var slot = document.querySelector('[data-theme-slot]')
      || document.querySelector('nav .nav-right')
      || document.querySelector('nav .nav-actions');
    if (slot) mount(slot);
    syncButtons();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoMount);
  } else {
    autoMount();
  }

  global.ArcTheme = {
    get: current,
    set: set,
    toggle: toggle,
    mount: mount,
    buttonHtml: buttonHtml,
    sync: syncButtons
  };
})(window);
