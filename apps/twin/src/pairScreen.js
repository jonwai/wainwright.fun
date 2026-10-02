/* Pair screen for the twin SPA — shown when no wfk_device_token is in
 * localStorage. Plain JS (the twin is not a React app); styles come from
 * index.html's <style> (#pair-root rules).
 */
import { pairDevice, extractPairingCode } from './pairing.js';

export function renderPairScreen(onPaired) {
  const root = document.getElementById('app');
  root.innerHTML = `
    <div id="pair-root" role="main">
      <div class="pair-card">
        <h1>Home Twin</h1>
        <p class="pair-lede">This iPad isn't paired yet.</p>
        <ol class="pair-steps">
          <li>Ask a grown-up to open <b>admin.wainwright.fun</b></li>
          <li>They tap <b>Pair a device</b> and pick your name</li>
          <li>Type the code they show you below</li>
        </ol>
        <form id="pair-form" autocomplete="off">
          <input id="pair-code" class="pair-input" type="text" inputmode="latin"
                 placeholder="PAIRING CODE" aria-label="Pairing code"
                 autocapitalize="characters" spellcheck="false" />
          <button type="submit" class="pair-btn">Pair this iPad</button>
          <p id="pair-error" class="pair-error" role="alert" hidden></p>
        </form>
        <p class="pair-alt">Or scan the QR code from the admin pairing screen with the Camera app.</p>
      </div>
    </div>`;
  const form = document.getElementById('pair-form');
  const input = document.getElementById('pair-code');
  const error = document.getElementById('pair-error');
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    error.hidden = true;
    const code = extractPairingCode(input.value ?? '');
    if (!code) {
      error.textContent = 'Enter the pairing code from a grown-up';
      error.hidden = false;
      return;
    }
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      await pairDevice(code);
      onPaired();
    } catch (err) {
      error.textContent = err.message || 'Could not pair this iPad';
      error.hidden = false;
      btn.disabled = false;
    }
  });
}
