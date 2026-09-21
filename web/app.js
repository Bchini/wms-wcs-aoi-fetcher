import { wmsBbox, wmsCrsParameter, serviceUrl, planWmsTiles } from './ogc.js';
import { runWcs, runWms } from './gdal-runner.js';

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

const WMS_TILE_SIZE = 1024;

// Best-effort client-side read of SERVICE/VERSION from the pasted URL, purely
// to label a feedback report — /api/resolve does its own, authoritative
// detection (including a GetCapabilities probe when the URL gives no hint).
function sniffService(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return 'wms'; }
  const service = (parsed.searchParams.get('service') || parsed.searchParams.get('SERVICE') || '').toLowerCase();
  if (['wms', 'wcs'].includes(service)) return service;
  return parsed.pathname.toLowerCase().includes('wcs') ? 'wcs' : 'wms';
}
function sniffVersion(rawUrl, service) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { parsed = null; }
  const version = parsed?.searchParams.get('version') || parsed?.searchParams.get('VERSION') || '';
  const valid = { wms: ['1.1.1', '1.3.0'], wcs: ['1.0.0'] };
  if (valid[service].includes(version)) return version;
  return service === 'wms' ? '1.3.0' : '1.0.0';
}

// Real progress, not a fake timer: resolving the URL is a fixed 5%, fetching
// and warping each tile advances proportionally to tiles done/total, and
// compositing the final mosaic covers the last stretch.
function setProgress(percent) {
  progressFill.style.width = `${percent}%`;
  progressFill.setAttribute('aria-valuenow', String(Math.round(percent)));
}
function showProgress() {
  progressFill.classList.remove('is-done', 'is-error');
  progressTrack.hidden = false;
  setProgress(0);
}
function updateProgress({ phase, done, total }) {
  const fraction = total ? done / total : 0;
  let percent = 0;
  if (phase === 'fetching') percent = 5 + 55 * fraction;
  else if (phase === 'processing') percent = 60 + 25 * fraction;
  else if (phase === 'compositing') percent = 85 + 13 * fraction;
  setProgress(Math.min(98, percent));
}
function finishProgress(success) {
  progressFill.classList.toggle('is-done', success);
  progressFill.classList.toggle('is-error', !success);
  if (success) setProgress(100);
  setTimeout(() => { progressTrack.hidden = true; setProgress(0); }, success ? 900 : 2500);
}

async function resolveUrl(url) {
  const response = await fetch('/api/resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function triggerDownload(blob, filename) {
  const downloadUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = downloadUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(downloadUrl);
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
  processStatus.textContent = 'Detecting the service, layer, and area…';
  showProgress();
  try {
    const resolved = await resolveUrl(url);
    setProgress(5);

    let blob;
    if (resolved.service === 'wcs') {
      processStatus.textContent = `Fetching ${resolved.layer} (WCS) and clipping in your browser…`;
      const params = {
        service: 'WCS',
        version: resolved.version,
        request: 'GetCoverage',
        coverage: resolved.layer,
        crs: resolved.crs,
        response_crs: resolved.crs,
        bbox: resolved.bounds.join(','),
        resx: String(resolved.resolution),
        resy: String(resolved.resolution),
        format: 'GeoTIFF',
      };
      blob = await runWcs(
        { url: serviceUrl(resolved.endpoint, params), bounds: resolved.bounds, resolution: resolved.resolution, crs: resolved.crs },
        updateProgress
      );
    } else {
      const [minx, miny, maxx, maxy] = resolved.bounds;
      const tiles = planWmsTiles({
        minx, miny, maxx, maxy,
        tileW: WMS_TILE_SIZE, tileH: WMS_TILE_SIZE, resolution: resolved.resolution,
      }).map((tile) => ({
        ...tile,
        url: serviceUrl(resolved.endpoint, {
          service: 'WMS',
          version: resolved.version,
          request: 'GetMap',
          layers: resolved.layer,
          styles: '',
          [wmsCrsParameter(resolved.version)]: resolved.crs,
          bbox: wmsBbox(tile.txmin, tile.tymin, tile.txmax, tile.tymax, resolved.crs, resolved.version),
          width: String(tile.width),
          height: String(tile.height),
          format: resolved.imageFormat,
        }),
      }));
      processStatus.textContent = `Fetching ${tiles.length} tile${tiles.length > 1 ? 's' : ''} from ${resolved.layer} (WMS) and mosaicking in your browser…`;
      blob = await runWms(
        { tiles, bounds: resolved.bounds, resolution: resolved.resolution, crs: resolved.crs },
        updateProgress
      );
    }

    triggerDownload(blob, `aoi_${resolved.service}.tif`);
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
