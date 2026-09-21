const form = document.querySelector('#fetch-form');
const wmsOptions = document.querySelector('#wms-options');
const wmtsOptions = document.querySelector('#wmts-options');
const version = document.querySelector('#version');
const modeTitle = document.querySelector('#mode-title');
const modeDescription = document.querySelector('#mode-description');
const endpointLabel = document.querySelector('#endpoint-label');
const endpoint = document.querySelector('#endpoint');
const layerLabel = document.querySelector('#layer-label');
const processStatus = document.querySelector('#process-status');
const launchButton = form.querySelector('.launch');
const feedbackForm = document.querySelector('#feedback-form');
const feedbackMessage = document.querySelector('#feedback-message');
const feedbackStatus = document.querySelector('#feedback-status');
const feedbackButton = feedbackForm.querySelector('button[type="submit"]');

function selectedService() { return new FormData(form).get('service'); }
function updateMode() {
  const service = selectedService();
  const wms = service === 'wms';
  const wmts = service === 'wmts';
  wmsOptions.hidden = !wms;
  wmtsOptions.hidden = !wmts;
  if (wms) {
    version.innerHTML = '<option value="1.1.1">WMS 1.1.1</option><option value="1.3.0">WMS 1.3.0</option>';
    endpointLabel.firstChild.textContent = 'WMS endpoint ';
    endpoint.placeholder = 'https://server.example.org/geoserver/wms';
    layerLabel.firstChild.textContent = 'Layer ID ';
    modeTitle.textContent = 'WMS returns rendered pixels.';
    modeDescription.textContent = 'Use it for a visual map. Colours are not elevation values.';
  } else if (wmts) {
    version.innerHTML = '<option value="1.0.0">WMTS 1.0.0</option>';
    endpointLabel.firstChild.textContent = 'WMTS GetCapabilities URL ';
    endpoint.placeholder = 'https://server.example.org/wmts?REQUEST=GetCapabilities';
    layerLabel.firstChild.textContent = 'WMTS layer ID ';
    modeTitle.textContent = 'WMTS returns tiled rendered pixels.';
    modeDescription.textContent = 'The selected tiles are clipped to your AOI and exported as a GeoTIFF.';
  } else {
    version.innerHTML = '<option value="1.0.0">WCS 1.0.0</option>';
    endpointLabel.firstChild.textContent = 'WCS endpoint ';
    endpoint.placeholder = 'https://server.example.org/geoserver/wcs';
    layerLabel.firstChild.textContent = 'Coverage ID ';
    modeTitle.textContent = 'WCS returns native values.';
    modeDescription.textContent = 'Use it for elevation, slope, statistics and other numeric analysis.';
  }
}
form.addEventListener('change', (event) => { if (event.target.name === 'service') updateMode(); });
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }

  const payload = new FormData(form);
  const aoi = payload.get('aoi');
  if (!(aoi instanceof File) || !aoi.size) {
    processStatus.textContent = 'Choose an AOI file before launching.';
    return;
  }
  if (aoi.size > 20 * 1024 * 1024) {
    processStatus.textContent = 'The AOI file must not exceed 20 MB.';
    return;
  }

  launchButton.disabled = true;
  launchButton.textContent = 'PROCESSING…';
  processStatus.textContent = 'Cloudflare is processing your AOI. Keep this page open until the download starts.';
  try {
    const response = await fetch('/api/process', { method: 'POST', body: payload });
    if (!response.ok) {
      let detail = 'The request could not be processed.';
      try {
        const body = await response.json();
        detail = body.detail || body.error || detail;
      } catch { /* The response was not JSON. */ }
      throw new Error(detail);
    }
    const file = await response.blob();
    const downloadUrl = URL.createObjectURL(file);
    const attachment = response.headers.get('content-disposition') || '';
    const matchedName = attachment.match(/filename="?([^";]+)"?/i);
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = matchedName?.[1] || `aoi_${selectedService()}.tif`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(downloadUrl);
    processStatus.textContent = 'Done — your GeoTIFF download has started.';
  } catch (error) {
    processStatus.textContent = `Processing failed: ${error.message}`;
  } finally {
    launchButton.disabled = false;
    launchButton.textContent = 'LANCER';
  }
});
feedbackForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = feedbackMessage.value.trim();
  if (!message) return;
  feedbackButton.disabled = true;
  feedbackStatus.textContent = 'Sending your report…';
  try {
    const response = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, service: selectedService(), protocol: version.value }),
    });
    if (!response.ok) throw new Error('Feedback request failed');
    feedbackForm.reset();
    feedbackStatus.textContent = 'Thank you — your report was saved. It will help improve the app.';
  } catch {
    feedbackStatus.textContent = 'Your report could not be saved. Please try again shortly.';
  } finally {
    feedbackButton.disabled = false;
  }
});
updateMode();
