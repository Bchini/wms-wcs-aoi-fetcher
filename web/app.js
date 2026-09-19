const form = document.querySelector('#fetch-form');
const command = document.querySelector('#command');
const copy = document.querySelector('#copy');
const download = document.querySelector('#download');
const status = document.querySelector('#status');
const wmsOptions = document.querySelector('#wms-options');
const version = document.querySelector('#version');
const modeTitle = document.querySelector('#mode-title');
const modeDescription = document.querySelector('#mode-description');

const quote = (value) => `"${String(value).replaceAll('"', '\\"')}"`;
function selectedService() { return new FormData(form).get('service'); }
function updateMode() {
  const wms = selectedService() === 'wms';
  wmsOptions.hidden = !wms;
  version.innerHTML = wms ? '<option value="1.1.1">WMS 1.1.1</option><option value="1.3.0">WMS 1.3.0</option>' : '<option value="1.0.0">WCS 1.0.0</option>';
  modeTitle.textContent = wms ? 'WMS returns rendered pixels.' : 'WCS returns native values.';
  modeDescription.textContent = wms ? 'Use it for a visual map. Colours are not elevation values.' : 'Use it for elevation, slope, statistics and other numeric analysis.';
  build();
}
function build() {
  const data = new FormData(form); const service = data.get('service');
  if (!form.checkValidity()) { command.textContent = 'Complete the required fields to generate a command.'; copy.disabled = download.disabled = true; return; }
  const args = ['py -3 fetch.py', `--service ${service}`, `--url ${quote(data.get('url'))}`, `--layer ${quote(data.get('layer'))}`, `--aoi ${quote(data.get('aoi'))}`, `--crs ${quote(data.get('crs').toUpperCase())}`, `--resolution ${data.get('resolution')}`, `--out ${quote(data.get('out'))}`];
  if (service === 'wcs') args.push(`--wcs-version ${data.get('version')}`);
  else args.push(`--wms-version ${data.get('version')}`, `--tile-size ${data.get('tileWidth')} ${data.get('tileHeight')}`, `--format ${data.get('format')}`);
  command.textContent = args.join(' ^\n  '); copy.disabled = download.disabled = false; status.textContent = 'Ready. The command runs locally; this page does not upload your AOI.';
}
form.addEventListener('input', build); form.addEventListener('change', (event) => event.target.name === 'service' ? updateMode() : build());
copy.addEventListener('click', async () => { await navigator.clipboard.writeText(command.textContent.replaceAll(' ^\n  ', ' ')); status.textContent = 'Command copied to the clipboard.'; });
download.addEventListener('click', () => { const blob = new Blob(['@echo off\r\n' + command.textContent.replaceAll(' ^\n  ', ' ') + '\r\npause\r\n'], { type: 'text/plain' }); const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'run-aoi-fetch.cmd' }); link.click(); URL.revokeObjectURL(link.href); status.textContent = 'Command file downloaded.'; });
updateMode();
