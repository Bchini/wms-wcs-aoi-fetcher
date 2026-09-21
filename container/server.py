"""HTTP service run by the Cloudflare GDAL Container.

The app takes a single WMS/WCS/WMTS URL and figures out everything else:
service, protocol version, layer, CRS, area, and resolution, whether the URL
is a bare endpoint, a GetCapabilities link, or a fully-formed
GetMap/GetCoverage request. See interpret_url() for the resolution order.
"""

from __future__ import annotations

import ipaddress
import json
import math
import shutil
import socket
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen
from xml.etree import ElementTree

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

# In the container image fetch.py sits next to this file in /app; in the
# repository it lives one level up.
CONTAINER_DIR = Path(__file__).resolve().parent
APP_DIR = CONTAINER_DIR if (CONTAINER_DIR / "fetch.py").exists() else CONTAINER_DIR.parent
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

import fetch  # noqa: E402 - the CLI module ships next to this server in the image

MAX_OUTPUT_BYTES = 250 * 1024 * 1024
MAX_REQUEST_PIXELS = 25_000_000
MAX_CAPABILITIES_BYTES = 5 * 1024 * 1024
GDAL_TIMEOUT_SECONDS = 600
DEFAULT_TARGET_PIXELS_PER_SIDE = 2048
WMS_TILE_SIZE = 1024

SUPPORTED_SERVICES = ("wms", "wcs", "wmts")
DEFAULT_VERSION = {"wms": "1.3.0", "wcs": "1.0.0", "wmts": "1.0.0"}
SUPPORTED_VERSIONS = {"wms": {"1.1.1", "1.3.0"}, "wcs": {"1.0.0"}, "wmts": {"1.0.0"}}

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


class ProcessRequest(BaseModel):
    url: str = Field(..., min_length=1, max_length=4096)


@dataclass
class ResolvedRequest:
    service: str
    endpoint: str
    version: str
    layer: str
    crs: str
    bounds: tuple[float, float, float, float]
    resolution: float
    image_format: str
    tile_matrix_set: str
    zoom_level: str


def cleanup(directory: Path) -> None:
    shutil.rmtree(directory, ignore_errors=True)


def blocked_address(host: str) -> bool:
    """True when the hostname resolves to an address we must not reach.

    Resolving first matters: a public name can point at 127.0.0.1, at an RFC1918
    address, or at the 169.254.169.254 cloud metadata endpoint.
    """
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        # Unresolvable here is not necessarily unresolvable from the fetch, so
        # let the request continue and fail with a service-level error.
        return False
    for info in infos:
        try:
            address = ipaddress.ip_address(info[4][0])
        except ValueError:
            continue
        if (
            address.is_private
            or address.is_loopback
            or address.is_link_local
            or address.is_reserved
            or address.is_multicast
            or address.is_unspecified
        ):
            return True
    return False


def validate_url(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise HTTPException(422, "Paste a full http(s) WMS/WCS/WMTS URL.")
    if len(value) > 4096:
        raise HTTPException(422, "The URL is too long.")
    host = parsed.hostname.lower()
    if host == "localhost" or host.endswith((".local", ".internal", ".localdomain")):
        raise HTTPException(422, "Local service URLs are not allowed.")
    if blocked_address(host):
        raise HTTPException(422, "Private or link-local service URLs are not allowed.")
    return value


def query_params(url: str) -> dict[str, str]:
    """OGC KVP parameter names are case-insensitive; normalize to upper case."""
    parsed = urlsplit(url)
    return {key.upper(): value for key, value in parse_qsl(parsed.query, keep_blank_values=True)}


def endpoint_only(url: str) -> str:
    parsed = urlsplit(url)
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))


def guess_service_from_path(url: str) -> str | None:
    path = urlsplit(url).path.lower()
    for candidate in ("wmts", "wcs", "wms"):
        if candidate in path:
            return candidate
    return None


def pixel_count(bounds: tuple[float, float, float, float], resolution: float) -> float:
    return ((bounds[2] - bounds[0]) / resolution) * ((bounds[3] - bounds[1]) / resolution)


def guard_pixel_budget(bounds: tuple[float, float, float, float], resolution: float) -> None:
    pixels = pixel_count(bounds, resolution)
    if not math.isfinite(pixels) or pixels > MAX_REQUEST_PIXELS:
        raise HTTPException(
            413,
            f"This area needs more than {MAX_REQUEST_PIXELS // 1_000_000} million output "
            "pixels. Paste a URL with a smaller BBOX, or a coarser WIDTH/HEIGHT.",
        )


def write_bbox_aoi(bounds: tuple[float, float, float, float], directory: Path, crs: str) -> Path:
    min_x, min_y, max_x, max_y = bounds
    aoi = directory / "bbox.geojson"
    geometry = {
        "type": "Polygon",
        "coordinates": [
            [[min_x, min_y], [max_x, min_y], [max_x, max_y], [min_x, max_y], [min_x, min_y]]
        ],
    }
    payload = {
        "type": "FeatureCollection",
        "crs": {"type": "name", "properties": {"name": crs}},
        "features": [{"type": "Feature", "properties": {}, "geometry": geometry}],
    }
    aoi.write_text(json.dumps(payload), encoding="utf-8")
    return aoi


def local_name(element: ElementTree.Element) -> str:
    return element.tag.rsplit("}", 1)[-1]


def direct_text(element: ElementTree.Element, name: str) -> str | None:
    for child in element:
        if local_name(child).lower() == name.lower() and child.text:
            return child.text.strip()
    return None


def capabilities_url(endpoint: str, service: str, version: str) -> str:
    parsed = urlsplit(endpoint)
    parameters = dict(parse_qsl(parsed.query, keep_blank_values=True))
    parameters.update(
        {"SERVICE": service.upper(), "REQUEST": "GetCapabilities", "VERSION": version}
    )
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(parameters), ""))


def capabilities_document(endpoint: str, service: str, version: str) -> ElementTree.Element:
    request = Request(
        capabilities_url(endpoint, service, version),
        headers={"User-Agent": fetch.USER_AGENT},
    )
    try:
        with urlopen(request, timeout=30) as response:  # noqa: S310 - scheme validated by caller
            contents = response.read(MAX_CAPABILITIES_BYTES + 1)
    except Exception as error:  # noqa: BLE001 - any transport failure is the same to the caller
        raise HTTPException(422, f"Could not read {service.upper()} capabilities from this URL.") from error
    if len(contents) > MAX_CAPABILITIES_BYTES:
        raise HTTPException(422, "The service capabilities document is too large.")
    try:
        return ElementTree.fromstring(contents)
    except ElementTree.ParseError as error:
        raise HTTPException(422, "The service returned invalid capabilities XML.") from error


def layer_identifier(element: ElementTree.Element, service: str) -> str | None:
    """The Name/Identifier of `element` if it is a real layer entry for `service`."""
    name = local_name(element)
    if service == "wmts":
        return direct_text(element, "Identifier") if name == "Layer" else None
    if service == "wcs":
        return direct_text(element, "Name") if name in {"CoverageOfferingBrief", "CoverageOffering"} else None
    return direct_text(element, "Name") if name == "Layer" else None


def box_from_element(
    element: ElementTree.Element, requested_crs: str
) -> tuple[tuple[float, float, float, float], str] | None:
    for child in element:
        if local_name(child) == "BoundingBox":
            crs_attr = child.attrib.get("CRS")
            srs_attr = child.attrib.get("SRS")
            source_crs = crs_attr or srs_attr
            if source_crs and source_crs.upper() == requested_crs.upper():
                try:
                    minx = float(child.attrib["minx"])
                    miny = float(child.attrib["miny"])
                    maxx = float(child.attrib["maxx"])
                    maxy = float(child.attrib["maxy"])
                except (KeyError, ValueError):
                    continue
                # WMS >= 1.3 (the "CRS" attribute, unlike 1.1's always-x/y
                # "SRS") reports EPSG:4326 in its registered lat/lon axis order.
                if crs_attr and source_crs.upper() == "EPSG:4326":
                    minx, miny, maxx, maxy = miny, minx, maxy, maxx
                return (minx, miny, maxx, maxy), source_crs
    for child in element:
        if local_name(child) == "EX_GeographicBoundingBox":
            try:
                return (
                    float(direct_text(child, "westBoundLongitude") or ""),
                    float(direct_text(child, "southBoundLatitude") or ""),
                    float(direct_text(child, "eastBoundLongitude") or ""),
                    float(direct_text(child, "northBoundLatitude") or ""),
                ), "EPSG:4326"
            except ValueError:
                continue
        if local_name(child) in {"WGS84BoundingBox", "lonLatEnvelope"}:
            lower = direct_text(child, "LowerCorner") or direct_text(child, "pos")
            positions = [
                grandchild.text.strip()
                for grandchild in child
                if local_name(grandchild) == "pos" and grandchild.text
            ]
            upper = direct_text(child, "UpperCorner") or (
                positions[1] if len(positions) > 1 else None
            )
            if lower and upper:
                try:
                    min_x, min_y = (float(value) for value in lower.split()[:2])
                    max_x, max_y = (float(value) for value in upper.split()[:2])
                    return (min_x, min_y, max_x, max_y), "EPSG:4326"
                except ValueError:
                    continue
        if local_name(child) == "LatLonBoundingBox":
            # WMS 1.1.1's geographic extent: always lon/lat order, no CRS attribute.
            try:
                return (
                    float(child.attrib["minx"]),
                    float(child.attrib["miny"]),
                    float(child.attrib["maxx"]),
                    float(child.attrib["maxy"]),
                ), "EPSG:4326"
            except (KeyError, ValueError):
                continue
    return None


def has_bounding_box(element: ElementTree.Element) -> bool:
    """True if `element` carries any kind of OGC bounding box as a direct child."""
    box_tags = {
        "BoundingBox",
        "EX_GeographicBoundingBox",
        "WGS84BoundingBox",
        "lonLatEnvelope",
        "LatLonBoundingBox",
    }
    return any(local_name(child) in box_tags for child in element)


def first_layer_name(root: ElementTree.Element, service: str) -> str | None:
    """The first real, georeferenced layer/coverage advertised by the service."""
    for element in root.iter():
        identifier = layer_identifier(element, service)
        if not identifier:
            continue
        if service == "wms" and not has_bounding_box(element):
            # Skip container <Layer> elements that carry a Name but no
            # bounding box of their own (INSPIRE-style capabilities nest the
            # real layers one level below a nameless or generic root layer).
            continue
        return identifier
    return None


def transform_bbox(
    bounds: tuple[float, float, float, float], source_crs: str, target_crs: str, directory: Path
) -> tuple[float, float, float, float]:
    if source_crs.upper() == target_crs.upper():
        return bounds
    min_x, min_y, max_x, max_y = bounds
    points = f"{min_x} {min_y}\n{min_x} {max_y}\n{max_x} {min_y}\n{max_x} {max_y}\n"
    try:
        transformed = subprocess.run(
            ["gdaltransform", "-s_srs", source_crs, "-t_srs", target_crs],
            input=points,
            capture_output=True,
            text=True,
            check=True,
            timeout=30,
            cwd=directory,
        ).stdout.splitlines()
        coordinates = [tuple(float(value) for value in line.split()[:2]) for line in transformed]
    except Exception as error:  # noqa: BLE001 - reported to the caller as one failure
        raise HTTPException(422, f"Could not transform the service extent to {target_crs}.") from error
    if len(coordinates) != 4:
        raise HTTPException(422, "Could not transform the service extent.")
    return (
        min(value[0] for value in coordinates),
        min(value[1] for value in coordinates),
        max(value[0] for value in coordinates),
        max(value[1] for value in coordinates),
    )


def advertised_bounds(
    service: str, endpoint: str, layer: str, version: str, crs: str, directory: Path
) -> tuple[float, float, float, float]:
    root = capabilities_document(endpoint, service, version)
    for element in root.iter():
        if layer_identifier(element, service) == layer:
            candidate = box_from_element(element, crs)
            if candidate:
                bounds, source_crs = candidate
                return transform_bbox(bounds, source_crs, crs, directory)
    raise HTTPException(
        422, f"The service did not advertise an extent for layer '{layer}'. Try a different URL."
    )


def probe_service(endpoint: str) -> tuple[str, ElementTree.Element]:
    """Try each service in turn when the URL gives no SERVICE hint at all."""
    for service in SUPPORTED_SERVICES:
        try:
            root = capabilities_document(endpoint, service, DEFAULT_VERSION[service])
        except HTTPException:
            continue
        if first_layer_name(root, service):
            return service, root
    raise HTTPException(
        422,
        "Could not detect a WMS, WCS, or WMTS service at this URL. Paste a service "
        "endpoint or a full GetCapabilities/GetMap/GetCoverage URL.",
    )


def interpret_url(raw_url: str, directory: Path) -> ResolvedRequest:
    """Fill in whatever a pasted URL leaves out: service, version, layer, CRS,
    area and resolution — from the URL's own query string first, then from
    the service's own GetCapabilities document.
    """
    raw_url = raw_url.strip()
    validate_url(raw_url)
    params = query_params(raw_url)
    endpoint = endpoint_only(raw_url)

    service = (params.get("SERVICE") or "").lower()
    root: ElementTree.Element | None = None
    if service not in SUPPORTED_SERVICES:
        service = guess_service_from_path(raw_url) or ""
    if service not in SUPPORTED_SERVICES:
        service, root = probe_service(endpoint)

    version = params.get("VERSION")
    if version not in SUPPORTED_VERSIONS[service]:
        version = DEFAULT_VERSION[service]

    layer = (
        params.get("LAYERS")
        or params.get("LAYER")
        or params.get("COVERAGE")
        or params.get("COVERAGEID")
        or params.get("TYPENAME")
        or params.get("TYPENAMES")
    )
    if layer and "," in layer:
        layer = layer.split(",", 1)[0]
    if not layer:
        if root is None:
            root = capabilities_document(endpoint, service, version)
        layer = first_layer_name(root, service)
        if not layer:
            raise HTTPException(
                422, f"The {service.upper()} service at this URL did not advertise any layer."
            )

    crs = (params.get("CRS") or params.get("SRS") or "EPSG:4326").upper()
    if not crs.startswith("EPSG:") or not crs[5:].isdigit():
        crs = "EPSG:4326"

    bbox_param = params.get("BBOX")
    width_param = params.get("WIDTH")
    height_param = params.get("HEIGHT")
    bounds: tuple[float, float, float, float] | None = None
    if bbox_param:
        try:
            raw_values = tuple(float(v.strip()) for v in bbox_param.split(","))
        except ValueError:
            raw_values = None
        if raw_values and len(raw_values) == 4 and all(math.isfinite(v) for v in raw_values):
            candidate = (
                fetch.bbox_param_to_geographic(raw_values, crs, version)
                if service == "wms"
                else raw_values
            )
            if candidate[0] < candidate[2] and candidate[1] < candidate[3]:
                bounds = candidate

    if bounds is None:
        bounds = advertised_bounds(service, endpoint, layer, version, crs, directory)
        # A full-extent fallback ignores a stray WIDTH/HEIGHT meant for a
        # different (smaller) BBOX than the one we just computed.
        width_param = height_param = None

    minx, miny, maxx, maxy = bounds
    if width_param and width_param.isdigit() and int(width_param) > 0:
        resolution = (maxx - minx) / int(width_param)
    elif height_param and height_param.isdigit() and int(height_param) > 0:
        resolution = (maxy - miny) / int(height_param)
    else:
        resolution = max(maxx - minx, maxy - miny) / DEFAULT_TARGET_PIXELS_PER_SIDE
    if not math.isfinite(resolution) or resolution <= 0:
        raise HTTPException(422, "Could not derive a usable resolution from this URL.")
    guard_pixel_budget(bounds, resolution)

    image_format = params.get("FORMAT", "")
    if image_format not in {"image/png", "image/jpeg"}:
        image_format = "image/png"

    tile_matrix_set = params.get("TILEMATRIXSET", "")
    zoom_level = params.get("TILEMATRIX") or params.get("ZOOMLEVEL") or ""
    if zoom_level and not zoom_level.isdigit():
        zoom_level = ""

    return ResolvedRequest(
        service=service,
        endpoint=endpoint,
        version=version,
        layer=layer,
        crs=crs,
        bounds=bounds,
        resolution=resolution,
        image_format=image_format,
        tile_matrix_set=tile_matrix_set,
        zoom_level=zoom_level,
    )


def run(command: list[str], directory: Path) -> None:
    try:
        completed = subprocess.run(
            command,
            cwd=directory,
            check=True,
            capture_output=True,
            text=True,
            timeout=GDAL_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as error:
        raise HTTPException(504, "The source server did not complete within 10 minutes.") from error
    except subprocess.CalledProcessError as error:
        detail = (error.stderr or error.stdout or "GDAL could not process this request.").strip()
        raise HTTPException(422, detail[-1800:]) from error
    if completed.stderr:
        print(completed.stderr[-2000:], flush=True)


def process_wmts(
    endpoint: str,
    layer: str,
    aoi: Path,
    output: Path,
    crs: str,
    resolution: float,
    tile_matrix_set: str,
    zoom_level: str,
    directory: Path,
) -> None:
    source = f"WMTS:{endpoint},layer={layer}"
    if tile_matrix_set:
        source += f",tilematrixset={tile_matrix_set}"
    if zoom_level:
        source += f",zoom_level={zoom_level}"
    run(
        [
            "gdalwarp", "-overwrite", "-cutline", str(aoi), "-crop_to_cutline",
            "-t_srs", crs, "-tr", str(resolution), str(resolution), "-tap",
            "-co", "TILED=YES", "-co", "COMPRESS=DEFLATE", "-co", "BIGTIFF=IF_SAFER",
            source, str(output),
        ],
        directory,
    )


def process_wms_or_wcs(
    service: str,
    endpoint: str,
    layer: str,
    aoi: Path,
    output: Path,
    crs: str,
    resolution: float,
    version: str,
    image_format: str,
    directory: Path,
) -> None:
    command = [
        sys.executable, str(APP_DIR / "fetch.py"), "--service", service,
        "--url", endpoint, "--layer", layer, "--aoi", str(aoi), "--crs", crs,
        "--resolution", str(resolution), "--out", str(output), "--timeout", "180",
        "--cleanup",
    ]
    if service == "wms":
        command.extend([
            "--wms-version", version, "--format", image_format,
            "--tile-size", str(WMS_TILE_SIZE), str(WMS_TILE_SIZE),
        ])
    else:
        command.extend(["--wcs-version", version, "--format", "GeoTIFF"])
    run(command, directory)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/process")
async def process(payload: ProcessRequest) -> FileResponse:
    directory = Path(tempfile.mkdtemp(prefix="wms-wcs-aoi-"))
    try:
        resolved = interpret_url(payload.url, directory)
        aoi_path = write_bbox_aoi(resolved.bounds, directory, resolved.crs)
        output = directory / "aoi_result.tif"
        if resolved.service == "wmts":
            process_wmts(
                resolved.endpoint, resolved.layer, aoi_path, output, resolved.crs,
                resolved.resolution, resolved.tile_matrix_set, resolved.zoom_level, directory,
            )
        else:
            process_wms_or_wcs(
                resolved.service, resolved.endpoint, resolved.layer, aoi_path, output,
                resolved.crs, resolved.resolution, resolved.version, resolved.image_format,
                directory,
            )
        if not output.is_file() or not output.stat().st_size:
            raise HTTPException(422, "The service returned no GeoTIFF output.")
        if output.stat().st_size > MAX_OUTPUT_BYTES:
            raise HTTPException(
                413, "Result exceeds the 250 MB download limit. Try a smaller area."
            )
        return FileResponse(
            output,
            media_type="image/tiff",
            filename=f"aoi_{resolved.service}.tif",
            background=BackgroundTask(cleanup, directory),
        )
    except HTTPException:
        cleanup(directory)
        raise
    except Exception as error:
        cleanup(directory)
        raise HTTPException(500, "Unexpected processing error.") from error
