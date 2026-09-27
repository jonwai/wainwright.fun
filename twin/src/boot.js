/* Entry gate for the twin SPA.
 *
 * Unpaired devices (no wfk_device_token in this web clip's isolated
 * localStorage) get the pair screen; the heavy three.js viewer is only
 * imported (and its assets fetched) after a successful pairing.
 */
import { getDeviceToken } from './pairing.js';
import { renderPairScreen } from './pairScreen.js';

if (!getDeviceToken()) {
  renderPairScreen(() => location.reload());
} else {
  await import('./main.js');
}
