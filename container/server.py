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
from urllib.parse import urlparse

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask


MAX_AOI_BYTES = 20 * 1024 * 1024
MAX_OUTPUT_BYTES = 250 * 1024 * 1024
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


def create_bbox_aoi(value: str, directory: Path) -> Path:
    try:
        coordinates = [float(part.strip()) for part in value.split(",")]
    except ValueError as error:
        raise HTTPException(422, "BBOX must use minX,minY,maxX,maxY.") from error
    if len(coordinates) != 4 or not all(math.isfinite(part) for part in coordinates):
        raise HTTPException(422, "BBOX must use four finite coordinates: minX,minY,maxX,maxY.")
    min_x, min_y, max_x, max_y = coordinates
    if min_x >= max_x or min_y >= max_y:
        raise HTTPException(422, "BBOX must have min values lower than max values.")
    aoi = directory / "bbox.geojson"
    geometry = {
        "type": "Polygon",
        "coordinates": [[[min_x, min_y], [max_x, min_y], [max_x, max_y], [min_x, max_y], [min_x, min_y]]],
    }
    aoi.write_text(json.dumps({"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {}, "geometry": geometry}]}), encoding="utf-8")
    return aoi


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
        aoi_path = await save_upload(aoi, directory) if aoi and aoi.filename else create_bbox_aoi(bbox, directory)
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
