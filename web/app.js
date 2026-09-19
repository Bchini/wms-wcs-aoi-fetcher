const form = document.querySelector('#fetch-form');
const wmsOptions = document.querySelector('#wms-options');
const version = document.querySelector('#version');
const modeTitle = document.querySelector('#mode-title');
const modeDescription = document.querySelector('#mode-description');
const feedbackForm = document.querySelector('#feedback-form');
const feedbackMessage = document.querySelector('#feedback-message');
const feedbackStatus = document.querySelector('#feedback-status');

function selectedService() { return new FormData(form).get('service'); }
function updateMode() {
  const wms = selectedService() === 'wms';
  wmsOptions.hidden = !wms;
  version.innerHTML = wms ? '<option value="1.1.1">WMS 1.1.1</option><option value="1.3.0">WMS 1.3.0</option>' : '<option value="1.0.0">WCS 1.0.0</option>';
  modeTitle.textContent = wms ? 'WMS returns rendered pixels.' : 'WCS returns native values.';
  modeDescription.textContent = wms ? 'Use it for a visual map. Colours are not elevation values.' : 'Use it for elevation, slope, statistics and other numeric analysis.';
}
form.addEventListener('change', (event) => { if (event.target.name === 'service') updateMode(); });
feedbackForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const message = feedbackMessage.value.trim();
  if (!message) return;
  const subject = 'AOI Raster Fetcher — error report';
  const body = `Error report:\n\n${message}\n\nService: ${selectedService().toUpperCase()}\nProtocol: ${version.value}`;
  window.location.href = `mailto:adel.bchini@gmail.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  feedbackStatus.textContent = 'Your email app should now be open. Please send the pre-filled report when ready.';
});
updateMode();
