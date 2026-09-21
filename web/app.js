const form = document.querySelector('#fetch-form');
const urlField = document.querySelector('#service-url');
const processStatus = document.querySelector('#process-status');
const launchButton = form.querySelector('.launch');
const progressTrack = document.querySelector('#progress-track');
const progressFill = document.querySelector('#progress-fill');
const feedbackForm = document.querySelector('#feedback-form');
const feedbackMessage = document.querySelector('#feedback-message');
const feedbackStatus = document.querySelector('#feedback-status');
const feedbackButton = feedbackForm.querySelector('button[type="submit"]');

// Best-effort client-side read of SERVICE/VERSION from the pasted URL, purely
// to label a feedback report — the server does its own, authoritative
// detection (including a GetCapabilities probe when the URL gives no hint).
function sniffService(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return 'wms'; }
  const service = (parsed.searchParams.get('service') || parsed.searchParams.get('SERVICE') || '').toLowerCase();
  if (['wms', 'wcs', 'wmts'].includes(service)) return service;
  const path = parsed.pathname.toLowerCase();
  if (path.includes('wmts')) return 'wmts';
  if (path.includes('wcs')) return 'wcs';
  return 'wms';
}
function sniffVersion(rawUrl, service) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { parsed = null; }
  const version = parsed?.searchParams.get('version') || parsed?.searchParams.get('VERSION') || '';
  const valid = { wms: ['1.1.1', '1.3.0'], wcs: ['1.0.0'], wmts: ['1.0.0'] };
  if (valid[service].includes(version)) return version;
  return service === 'wms' ? '1.3.0' : '1.0.0';
}

// There is no server-side progress feed (the container returns the finished
// file in one response), so this approaches 92% on a decelerating curve that
// never promises a false ETA, then jumps to 100% once the response lands.
let progressTimer = null;
function setProgress(percent) {
  progressFill.style.width = `${percent}%`;
  progressFill.setAttribute('aria-valuenow', String(Math.round(percent)));
}
function startProgress() {
  clearInterval(progressTimer);
  progressFill.classList.remove('is-done', 'is-error');
  progressTrack.hidden = false;
  const startedAt = Date.now();
  setProgress(0);
  progressTimer = setInterval(() => {
    const elapsedSeconds = (Date.now() - startedAt) / 1000;
    setProgress(92 * (1 - Math.exp(-elapsedSeconds / 20)));
  }, 250);
}
function finishProgress(success) {
  clearInterval(progressTimer);
  progressFill.classList.toggle('is-done', success);
  progressFill.classList.toggle('is-error', !success);
  if (success) setProgress(100);
  setTimeout(() => { progressTrack.hidden = true; setProgress(0); }, success ? 900 : 2500);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }

  const url = urlField.value.trim();
  launchButton.disabled = true;
  launchButton.textContent = 'RUNNING…';
  processStatus.textContent = 'Cloudflare is detecting the service, layer, and area, then processing your request.';
  startProgress();
  try {
    const response = await fetch('/api/process', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (!response.ok) {
      // Errors from the Cloudflare runtime itself (a container failing to
      // start, an upstream 502) are plain text, not the FastAPI JSON body —
      // fall back to that raw text rather than a meaningless generic message.
      const rawBody = await response.text();
      let detail = rawBody;
      try {
        const body = JSON.parse(rawBody);
        detail = body.detail || body.error || rawBody;
      } catch { /* The response was not JSON; use the raw text as-is. */ }
      throw new Error(detail || `HTTP ${response.status}`);
    }
    const file = await response.blob();
    const downloadUrl = URL.createObjectURL(file);
    const attachment = response.headers.get('content-disposition') || '';
    const matchedName = attachment.match(/filename="?([^";]+)"?/i);
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = matchedName?.[1] || 'aoi_result.tif';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(downloadUrl);
    processStatus.textContent = 'Done — your GeoTIFF download has started.';
    finishProgress(true);
  } catch (error) {
    processStatus.textContent = `Processing failed: ${error.message}`;
    finishProgress(false);
  } finally {
    launchButton.disabled = false;
    launchButton.textContent = 'RUN';
  }
});

feedbackForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = feedbackMessage.value.trim();
  if (!message) return;
  const service = sniffService(urlField.value.trim());
  feedbackButton.disabled = true;
  feedbackStatus.textContent = 'Sending your report…';
  try {
    const response = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, service, protocol: sniffVersion(urlField.value.trim(), service) }),
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
