#!/usr/bin/env python3
"""WMS/WCS AOI fetcher.

Downloads a raster (e.g. a DSM/DTM layer) from a WMS or WCS service, clipped
to an AOI vector file, and reassembles it into a single GeoTIFF.

Two modes:
  - wcs: single GetCoverage request against the AOI bounding box. Use this
    when the server exposes the layer as a WCS coverage and can return the
    native pixel values (e.g. Float32 elevation) in one shot.
  - wms: tiled GetMap requests (WMS servers usually cap the pixel size per
    request), mosaicked with gdalbuildvrt/gdal_translate and clipped to the
    AOI with gdalwarp. WMS returns a rendered image (e.g. RGB/PNG), not raw
    values, unless the server explicitly serves single-band imagery.

Requires GDAL command-line tools (ogrinfo, gdal_translate, gdalbuildvrt,
gdalwarp) on PATH, or pointed to via --gdal-bin.
"""

from __future__ import annotations

import argparse
import math
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


def gdal_env(gdal_bin: Path | None) -> dict[str, str]:
    env = os.environ.copy()
    # A stray GDAL_DRIVER_PATH pointing at an unrelated GDAL build breaks
    # driver loading (seen with QGIS/other GDAL installs coexisting).
    env.pop("GDAL_DRIVER_PATH", None)
    if gdal_bin:
        env["PATH"] = str(gdal_bin) + os.pathsep + env.get("PATH", "")
    return env


def tool(name: str, gdal_bin: Path | None) -> str:
    return str(gdal_bin / f"{name}.exe") if gdal_bin and os.name == "nt" else name


def run(args: list[str], gdal_bin: Path | None) -> None:
    subprocess.run(args, check=True, env=gdal_env(gdal_bin))


def wms_bbox(minx: float, miny: float, maxx: float, maxy: float, crs: str, version: str) -> str:
    """Return a WMS BBOX, accounting for the WMS 1.3 EPSG:4326 axis order."""
    if version == "1.3.0" and crs.upper() == "EPSG:4326":
        return f"{miny},{minx},{maxy},{maxx}"
    return f"{minx},{miny},{maxx},{maxy}"


def wms_crs_parameter(version: str) -> str:
    return "crs" if version == "1.3.0" else "srs"


def service_url(base_url: str, params: dict[str, str]) -> str:
    """Append encoded OGC parameters to endpoints with or without a query string."""
    if "?" not in base_url:
        separator = "?"
    elif base_url.endswith(("?", "&")):
        separator = ""
    else:
        separator = "&"
    return base_url + separator + urllib.parse.urlencode(params, safe=":,/")


def aoi_extent(aoi_path: Path, gdal_bin: Path | None) -> tuple[float, float, float, float]:
    """Return (minx, miny, maxx, maxy) of the AOI, in the AOI's own CRS.

    The AOI file must already be in the CRS you intend to query the
    service with (reproject first with ogr2ogr if needed).
    """
    out = subprocess.run(
        [tool("ogrinfo", gdal_bin), "-al", "-so", str(aoi_path)],
        check=True,
        capture_output=True,
        text=True,
        env=gdal_env(gdal_bin),
    ).stdout
    match = re.search(
        r"Extent:\s*\(([-\d.]+),\s*([-\d.]+)\)\s*-\s*\(([-\d.]+),\s*([-\d.]+)\)", out
    )
    if not match:
        raise RuntimeError(f"Could not parse extent from ogrinfo output for {aoi_path}")
    minx, miny, maxx, maxy = (float(g) for g in match.groups())
    return minx, miny, maxx, maxy


def http_get(url: str, destination: Path | None, attempts: int, timeout: int) -> bytes | None:
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "wms-wcs-aoi-fetcher/1.0"})
            with urllib.request.urlopen(req, timeout=timeout) as response:
                if destination is None:
                    return response.read()
                temp = destination.with_suffix(destination.suffix + ".part")
                with temp.open("wb") as fh:
                    first_chunk = response.read(4096)
                    content_type = response.headers.get_content_type().lower()
                    if content_type in {"text/xml", "application/xml", "text/html"} or b"ServiceException" in first_chunk:
                        detail = first_chunk.decode("utf-8", errors="replace").strip()
                        raise RuntimeError(f"Server returned an OGC/service error instead of raster data: {detail[:500]}")
                    fh.write(first_chunk)
                    while chunk := response.read(1024 * 1024):
                        fh.write(chunk)
                temp.replace(destination)
                return None
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last_error = exc
            if attempt == attempts:
                break
            time.sleep(min(30, 3 * attempt))
    raise RuntimeError(f"Request failed after {attempts} attempts: {url}") from last_error


def fetch_wcs(args: argparse.Namespace) -> Path:
    minx, miny, maxx, maxy = aoi_extent(Path(args.aoi), args.gdal_bin)
    params = {
        "service": "WCS",
        "version": args.wcs_version,
        "request": "GetCoverage",
        "coverage": args.layer,
        "crs": args.crs,
        "response_crs": args.crs,
        "bbox": f"{minx},{miny},{maxx},{maxy}",
        "resx": str(args.resolution),
        "resy": str(args.resolution),
        "format": args.format or "GeoTIFF",
    }
    url = service_url(args.url, params)
    print(f"GetCoverage: {url}", flush=True)

    raw = Path(args.out).with_name(Path(args.out).stem + "_RAW.tif")
    http_get(url, raw, attempts=args.retries, timeout=args.timeout)

    clipped = Path(args.out)
    run(
        [
            tool("gdalwarp", args.gdal_bin),
            "-overwrite",
            "-cutline",
            args.aoi,
            "-crop_to_cutline",
            "-co",
            "TILED=YES",
            "-co",
            "COMPRESS=DEFLATE",
            str(raw),
            str(clipped),
        ],
        args.gdal_bin,
    )
    return clipped


def fetch_wms(args: argparse.Namespace) -> Path:
    minx, miny, maxx, maxy = aoi_extent(Path(args.aoi), args.gdal_bin)
    tile_w, tile_h = args.tile_size
    cols = math.ceil((maxx - minx) / (tile_w * args.resolution))
    rows = math.ceil((maxy - miny) / (tile_h * args.resolution))

    # Keep resumable tile caches separate when several outputs share a folder.
    tiles_dir = Path(args.out).parent / f"{Path(args.out).stem}_tiles"
    tiles_dir.mkdir(parents=True, exist_ok=True)
    tif_paths: list[Path] = []

    total = cols * rows
    index = 0
    for row in range(rows):
        tymax = maxy - row * tile_h * args.resolution
        tymin = max(miny, tymax - tile_h * args.resolution)
        height = round((tymax - tymin) / args.resolution)
        for col in range(cols):
            index += 1
            txmin = minx + col * tile_w * args.resolution
            txmax = min(maxx, txmin + tile_w * args.resolution)
            width = round((txmax - txmin) / args.resolution)

            stem = f"tile_r{row:02d}_c{col:02d}"
            png = tiles_dir / f"{stem}.{args.image_ext}"
            tif = tiles_dir / f"{stem}.tif"

            if not tif.exists():
                params = {
                    "service": "WMS",
                    "version": args.wms_version,
                    "request": "GetMap",
                    "layers": args.layer,
                    "styles": "",
                    wms_crs_parameter(args.wms_version): args.crs,
                    "bbox": wms_bbox(txmin, tymin, txmax, tymax, args.crs, args.wms_version),
                    "width": str(width),
                    "height": str(height),
                    "format": args.format or "image/png",
                }
                get_map_url = service_url(args.url, params)
                target_url = get_map_url
                if args.relay == "microlink":
                    # Renders the WMS response through a headless-browser
                    # screenshot service. Useful when the WMS server blocks
                    # direct requests from your network (e.g. geo-fencing)
                    # but still serves normal browser traffic. Only usable
                    # for image formats (PNG/JPEG), never for raw WCS data.
                    relay_params = {
                        "url": get_map_url,
                        "screenshot": "true",
                        "meta": "false",
                        "viewport.width": str(width),
                        "viewport.height": str(height),
                        "viewport.deviceScaleFactor": "1",
                    }
                    relay_url = "https://api.microlink.io/?" + urllib.parse.urlencode(
                        relay_params
                    )
                    import json

                    payload_bytes = http_get(relay_url, None, args.retries, args.timeout)
                    payload = json.loads(payload_bytes)
                    target_url = payload["data"]["screenshot"]["url"]

                print(f"[{index:02d}/{total:02d}] {stem} {width}x{height}", flush=True)
                http_get(target_url, png, attempts=args.retries, timeout=args.timeout)
                run(
                    [
                        tool("gdal_translate", args.gdal_bin),
                        "-of",
                        "GTiff",
                        "-a_srs",
                        args.crs,
                        "-a_ullr",
                        str(txmin),
                        str(tymax),
                        str(txmax),
                        str(tymin),
                        "-co",
                        "TILED=YES",
                        "-co",
                        "COMPRESS=DEFLATE",
                        str(png),
                        str(tif),
                    ],
                    args.gdal_bin,
                )
            tif_paths.append(tif)

    vrt = Path(args.out).with_suffix(".vrt")
    run([tool("gdalbuildvrt", args.gdal_bin), "-overwrite", str(vrt), *map(str, tif_paths)], args.gdal_bin)

    mosaic = Path(args.out).with_name(Path(args.out).stem + "_MOSAIC.tif")
    run(
        [
            tool("gdal_translate", args.gdal_bin),
            "-of",
            "GTiff",
            "-co",
            "TILED=YES",
            "-co",
            "COMPRESS=DEFLATE",
            "-co",
            "BIGTIFF=IF_SAFER",
            str(vrt),
            str(mosaic),
        ],
        args.gdal_bin,
    )

    clipped = Path(args.out)
    run(
        [
            tool("gdalwarp", args.gdal_bin),
            "-overwrite",
            "-cutline",
            args.aoi,
            "-crop_to_cutline",
            "-dstalpha",
            "-tr",
            str(args.resolution),
            str(args.resolution),
            "-tap",
            "-co",
            "TILED=YES",
            "-co",
            "COMPRESS=DEFLATE",
            "-co",
            "BIGTIFF=IF_SAFER",
            str(mosaic),
            str(clipped),
        ],
        args.gdal_bin,
    )
    return clipped


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--service", choices=["wms", "wcs"], required=True)
    parser.add_argument("--url", required=True, help="Base WMS/WCS endpoint URL")
    parser.add_argument("--layer", required=True, help="WMS layer name or WCS coverage id")
    parser.add_argument("--aoi", required=True, help="Vector file (any GDAL/OGR format) defining the area of interest, already in --crs")
    parser.add_argument("--crs", required=True, help="e.g. EPSG:31982")
    parser.add_argument("--resolution", type=float, default=1.0, help="Output resolution in CRS units per pixel (default: 1)")
    parser.add_argument("--out", required=True, help="Output GeoTIFF path")
    parser.add_argument("--format", default=None, help="WMS image format (default image/png) or WCS format (default GeoTIFF)")
    parser.add_argument("--tile-size", type=int, nargs=2, default=[1024, 1024], metavar=("WIDTH", "HEIGHT"), help="WMS tile size in pixels (default: 1024 1024)")
    parser.add_argument("--image-ext", default="png", help="File extension for downloaded WMS tiles (default: png)")
    parser.add_argument("--wms-version", choices=["1.1.1", "1.3.0"], default="1.1.1")
    parser.add_argument("--wcs-version", choices=["1.0.0"], default="1.0.0", help="WCS 1.0.0 GetCoverage version")
    parser.add_argument("--relay", choices=["none", "microlink"], default="none", help="Fetch WMS tiles through a screenshot relay (see --help text on fetch_wms). Never applies to WCS.")
    parser.add_argument("--gdal-bin", type=Path, default=None, help="Directory containing GDAL binaries, if not on PATH")
    parser.add_argument("--retries", type=int, default=5)
    parser.add_argument("--timeout", type=int, default=180)
    args = parser.parse_args(argv)
    if args.resolution <= 0:
        parser.error("--resolution must be greater than zero")
    if any(value <= 0 for value in args.tile_size):
        parser.error("--tile-size values must be greater than zero")
    if args.retries < 1:
        parser.error("--retries must be at least 1")
    if args.timeout < 1:
        parser.error("--timeout must be at least 1")
    return args


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    result = fetch_wcs(args) if args.service == "wcs" else fetch_wms(args)
    print(f"OUTPUT={result}")


if __name__ == "__main__":
    main()
