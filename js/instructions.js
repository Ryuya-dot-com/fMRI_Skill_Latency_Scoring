/**
 * instructions.js - Japanese scoring instructions slide-out panel
 */
const Instructions = (() => {
  let _visible = false;
  let _initialized = false;

  function init() {
    if (_initialized) return;
    _initialized = true;
    document.getElementById('instructions-toggle')
      .addEventListener('click', toggle);
    document.getElementById('instructions-close')
      .addEventListener('click', hide);
  }

  function toggle() {
    _visible ? hide() : show();
  }

  function show() {
    document.getElementById('instructions-panel').style.display = 'block';
    _visible = true;
  }

  function hide() {
    document.getElementById('instructions-panel').style.display = 'none';
    _visible = false;
  }

  function isVisible() { return _visible; }

  return { init, toggle, show, hide, isVisible };
})();
