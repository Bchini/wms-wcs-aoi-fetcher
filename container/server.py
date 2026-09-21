"""HTTP service run by the Cloudflare GDAL Container."""

from __future__ import annotations

import ipaddress
import json
import math
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlparse, urlsplit, urlunsplit
from urllib.request import Request, urlopen
from xml.etree import ElementTree

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask


MAX_AOI_BYTES = 20 * 1024 * 1024
MAX_OUTPUT_BYTES = 250 * 1024 * 1024
MAX_FULL_EXTENT_PIXELS = 25_000_000
ALLOWED_AOI_SUFFIXES = {".geojson", ".json", ".gpkg", ".zip"}
APP_DIR = Path("/app")

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


def cleanup(directory: Path) -> None:
    shutil.rmtree(directory, ignore_errors=True)


def validate_url(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise HTTPException(422, "The service URL must be an HTTP(S) URL.")
    host = parsed.hostname.lower()
    if host == "localhost" or host.endswith(".local"):
        raise HTTPException(422, "Local service URLs are not allowed.")
    try:
        if ipaddress.ip_address(host).is_private or ipaddress.ip_address(host).is_loopback:
            raise HTTPException(422, "Private service URLs are not allowed.")
    except ValueError:
        pass
    return value


def require_text(value: str, label: str, limit: int = 512) -> str:
    cleaned = value.strip()
    if not cleaned or len(cleaned) > limit or "\x00" in cleaned:
        raise HTTPException(422, f"Invalid {label}.")
    return cleaned


def parse_bbox(value: str) -> tuple[float, float, float, float]:
    try:
        coordinates = [float(part.strip()) for part in value.split(",")]
    except ValueError as error:
        raise HTTPException(422, "BBOX must use minX,minY,maxX,maxY.") from error
    if len(coordinates) != 4 or not all(math.isfinite(part) for part in coordinates):
        raise HTTPException(422, "BBOX must use four finite coordinates: minX,minY,maxX,maxY.")
    min_x, min_y, max_x, max_y = coordinates
    if min_x >= max_x or min_y >= max_y:
        raise HTTPException(422, "BBOX must have min values lower than max values.")
    return min_x, min_y, max_x, max_y


def create_bbox_aoi(value: str, directory: Path, crs: str) -> Path:
    min_x, min_y, max_x, max_y = parse_bbox(value)
    aoi = directory / "bbox.geojson"
    geometry = {
        "type": "Polygon",
        "coordinates": [[[min_x, min_y], [max_x, min_y], [max_x, max_y], [min_x, max_y], [min_x, min_y]]],
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
    parameters.update({"SERVICE": service.upper(), "REQUEST": "GetCapabilities", "VERSION": version})
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(parameters), ""))


def capabilities_document(endpoint: str, service: str, version: str) -> ElementTree.Element:
    request = Request(capabilities_url(endpoint, service, version), headers={"User-Agent": "wms-wcs-aoi-fetcher/1.0"})
    try:
        with urlopen(request, timeout=30) as response:
            contents = response.read(5 * 1024 * 1024 + 1)
    except Exception as error:
        raise HTTPException(422, "Could not read the service capabilities for its full extent.") from error
    if len(contents) > 5 * 1024 * 1024:
        raise HTTPException(422, "The service capabilities document is too large.")
    try:
        return ElementTree.fromstring(contents)
    except ElementTree.ParseError as error:
        raise HTTPException(422, "The service returned invalid capabilities XML.") from error


def box_from_element(element: ElementTree.Element, requested_crs: str) -> tuple[tuple[float, float, float, float], str] | None:
    for child in element:
        if local_name(child) == "BoundingBox":
            source_crs = child.attrib.get("CRS") or child.attrib.get("SRS")
            if source_crs and source_crs.upper() == requested_crs:
                try:
                    return (float(child.attrib["minx"]), float(child.attrib["miny"]), float(child.attrib["maxx"]), float(child.attrib["maxy"])), source_crs
                except (KeyError, ValueError):
                    continue
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
            positions = [grandchild.text.strip() for grandchild in child if local_name(grandchild) == "pos" and grandchild.text]
            upper = direct_text(child, "UpperCorner") or (positions[1] if len(positions) > 1 else None)
            if lower and upper:
                try:
                    min_x, min_y = (float(value) for value in lower.split()[:2])
                    max_x, max_y = (float(value) for value in upper.split()[:2])
                    return (min_x, min_y, max_x, max_y), "EPSG:4326"
                except ValueError:
                    continue
    return None


def transform_bbox(bounds: tuple[float, float, float, float], source_crs: str, target_crs: str, directory: Path) -> tuple[float, float, float, float]:
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
    except Exception as error:
        raise HTTPException(422, f"Could not transform the advertised service extent to {target_crs}.") from error
    if len(coordinates) != 4:
        raise HTTPException(422, "Could not transform the advertised service extent.")
    return min(value[0] for value in coordinates), min(value[1] for value in coordinates), max(value[0] for value in coordinates), max(value[1] for value in coordinates)


def advertised_extent(service: str, endpoint: str, layer: str, version: str, crs: str, resolution: float, directory: Path) -> Path:
    root = capabilities_document(endpoint, service, version)
    layer_elements = []
    for element in root.iter():
        element_name = local_name(element)
        identifier = direct_text(element, "Identifier") if service == "wmts" and element_name == "Layer" else direct_text(element, "Name")
        if identifier == layer:
            layer_elements.append(element)
    for element in layer_elements:
        candidate = box_from_element(element, crs)
        if candidate:
            bounds, source_crs = candidate
            transformed = transform_bbox(bounds, source_crs, crs, directory)
            pixels = ((transformed[2] - transformed[0]) / resolution) * ((transformed[3] - transformed[1]) / resolution)
            if not math.isfinite(pixels) or pixels > MAX_FULL_EXTENT_PIXELS:
                raise HTTPException(413, "The full service extent exceeds 25 million output pixels. Upload an AOI or enter a smaller BBOX.")
            return create_bbox_aoi(
                ",".join(str(value) for value in transformed), directory, crs
            )
    raise HTTPException(422, "The service did not advertise an extent for this layer. Upload an AOI or enter a BBOX.")


async def save_upload(upload: UploadFile, directory: Path) -> Path:
    suffix = Path(upload.filename or "").suffix.lower()
    if suffix not in ALLOWED_AOI_SUFFIXES:
        raise HTTPException(422, "Upload a GeoJSON, GeoPackage, or ZIP Shapefile.")
    target = directory / f"aoi{suffix}"
    size = 0
    with target.open("wb") as stream:
        while chunk := await upload.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_AOI_BYTES:
                raise HTTPException(413, "AOI upload must not exceed 20 MB.")
            stream.write(chunk)
    if not size:
        raise HTTPException(422, "The AOI upload is empty.")
    if suffix == ".zip":
        extracted = directory / "unzipped_aoi"
        extracted.mkdir()
        try:
            with zipfile.ZipFile(target) as archive:
                for member in archive.infolist():
                    candidate = (extracted / member.filename).resolve()
                    if not candidate.is_relative_to(extracted.resolve()):
                        raise HTTPException(422, "The AOI ZIP contains an unsafe path.")
                archive.extractall(extracted)
        except zipfile.BadZipFile as error:
            raise HTTPException(422, "The AOI ZIP is not a valid ZIP file.") from error
        shapefiles = list(extracted.rglob("*.shp"))
        if len(shapefiles) != 1:
            raise HTTPException(422, "The AOI ZIP must contain exactly one Shapefile (.shp plus sidecar files).")
        return shapefiles[0]
    return target


def run(command: list[str], directory: Path) -> None:
    try:
        completed = subprocess.run(
            command,
            cwd=directory,
            check=True,
            capture_output=True,
            text=True,
            timeout=600,
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
    tile_width: str,
    tile_height: str,
    directory: Path,
) -> None:
    command = [
        sys.executable, str(APP_DIR / "fetch.py"), "--service", service,
        "--url", endpoint, "--layer", layer, "--aoi", str(aoi), "--crs", crs,
        "--resolution", str(resolution), "--out", str(output), "--timeout", "180",
    ]
    if service == "wms":
        command.extend([
            "--wms-version", version, "--format", image_format,
            "--tile-size", tile_width, tile_height,
        ])
    else:
        command.extend(["--wcs-version", version, "--format", "GeoTIFF"])
    run(command, directory)


@app.post("/api/process")
async def process(
    aoi: UploadFile | None = File(None),
    bbox: str = Form(""),
    service: str = Form(...),
    url: str = Form(...),
    layer: str = Form(...),
    version: str = Form(...),
    crs: str = Form(...),
    resolution: float = Form(...),
    format: str = Form("image/png"),
    tileWidth: str = Form("1024"),
    tileHeight: str = Form("1024"),
    tileMatrixSet: str = Form(""),
    zoomLevel: str = Form(""),
    fullExtent: str = Form(""),
) -> FileResponse:
    if service not in {"wcs", "wms", "wmts"}:
        raise HTTPException(422, "Unsupported service.")
    if (service == "wcs" and version != "1.0.0") or (service == "wms" and version not in {"1.1.1", "1.3.0"}) or (service == "wmts" and version != "1.0.0"):
        raise HTTPException(422, "Unsupported protocol version.")
    if not resolution or resolution <= 0:
        raise HTTPException(422, "Resolution must be greater than zero.")
    endpoint = validate_url(url.strip())
    layer = require_text(layer, "layer")
    crs = require_text(crs, "CRS", 64).upper()
    if not crs.startswith("EPSG:") or not crs[5:].isdigit():
        raise HTTPException(422, "CRS must use the EPSG:xxxx form.")
    if format not in {"image/png", "image/jpeg"}:
        raise HTTPException(422, "Unsupported WMS image format.")
    if not tileWidth.isdigit() or not tileHeight.isdigit() or not (0 < int(tileWidth) <= 4096 and 0 < int(tileHeight) <= 4096):
        raise HTTPException(422, "WMS tile dimensions must be between 1 and 4096.")
    if zoomLevel and (not zoomLevel.isdigit() or int(zoomLevel) > 30):
        raise HTTPException(422, "WMTS zoom level must be between 0 and 30.")

    directory = Path(tempfile.mkdtemp(prefix="wms-wcs-aoi-"))
    try:
        if aoi and aoi.filename:
            aoi_path = await save_upload(aoi, directory)
        elif bbox.strip():
            aoi_path = create_bbox_aoi(bbox, directory, crs)
        elif fullExtent == "on":
            aoi_path = advertised_extent(service, endpoint, layer, version, crs, resolution, directory)
        else:
            raise HTTPException(422, "Upload an AOI, enter a BBOX, or enable the full service extent.")
        output = directory / "aoi_result.tif"
        if service == "wmts":
            process_wmts(endpoint, layer, aoi_path, output, crs, resolution, tileMatrixSet.strip(), zoomLevel, directory)
        else:
            process_wms_or_wcs(service, endpoint, layer, aoi_path, output, crs, resolution, version, format, tileWidth, tileHeight, directory)
        if not output.is_file() or not output.stat().st_size:
            raise HTTPException(422, "The service returned no GeoTIFF output.")
        if output.stat().st_size > MAX_OUTPUT_BYTES:
            raise HTTPException(413, "Result exceeds the 250 MB download limit. Use a smaller AOI or a lower resolution.")
        return FileResponse(
            output,
            media_type="image/tiff",
            filename=f"aoi_{service}.tif",
            background=BackgroundTask(cleanup, directory),
        )
    except HTTPException:
        cleanup(directory)
        raise
    except Exception as error:
        cleanup(directory)
        raise HTTPException(500, "Unexpected processing error.") from error
