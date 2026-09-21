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
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

USER_AGENT = "wms-wcs-aoi-fetcher/1.1"

# ogrinfo prints one "Extent:" line per layer; coordinates may be written in
# scientific notation for large projected values.
NUMBER = r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?"
EXTENT_RE = re.compile(
    rf"Extent:\s*\(\s*({NUMBER})\s*,\s*({NUMBER})\s*\)\s*-\s*\(\s*({NUMBER})\s*,\s*({NUMBER})\s*\)"
)

# HTTP statuses worth retrying; every other 4xx is a permanent client error
# and retrying only delays the failure.
RETRYABLE_STATUSES = {408, 425, 429, 500, 502, 503, 504}


class FetchError(RuntimeError):
    """An error meant to be reported to the user without a traceback."""


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
    try:
        subprocess.run(args, check=True, env=gdal_env(gdal_bin))
    except FileNotFoundError as exc:
        raise FetchError(
            f"GDAL tool not found: {args[0]}. Put the GDAL binaries on PATH or pass --gdal-bin."
        ) from exc
    except subprocess.CalledProcessError as exc:
        raise FetchError(f"{Path(args[0]).stem} failed (exit code {exc.returncode}).") from exc


def wms_bbox(minx: float, miny: float, maxx: float, maxy: float, crs: str, version: str) -> str:
    """Return a WMS BBOX, accounting for the WMS 1.3 EPSG:4326 axis order."""
    if version == "1.3.0" and crs.upper() == "EPSG:4326":
        return f"{miny},{minx},{maxy},{maxx}"
    return f"{minx},{miny},{maxx},{maxy}"


def wms_crs_parameter(version: str) -> str:
    return "crs" if version == "1.3.0" else "srs"


def bbox_param_to_geographic(
    values: tuple[float, float, float, float], crs: str, version: str
) -> tuple[float, float, float, float]:
    """Invert wms_bbox(): turn a BBOX taken from a pasted GetMap URL back into
    (minx, miny, maxx, maxy) in standard axis order.

    A WMS 1.3 BBOX for EPSG:4326 is written latitude-first; every other
    combination is already minx,miny,maxx,maxy.
    """
    v0, v1, v2, v3 = values
    if version == "1.3.0" and crs.upper() == "EPSG:4326":
        return v1, v0, v3, v2
    return v0, v1, v2, v3


def service_url(base_url: str, params: dict[str, str]) -> str:
    """Append encoded OGC parameters to endpoints with or without a query string."""
    if "?" not in base_url:
        separator = "?"
    elif base_url.endswith(("?", "&")):
        separator = ""
    else:
        separator = "&"
    return base_url + separator + urllib.parse.urlencode(params, safe=":,/")


def parse_extents(text: str) -> list[tuple[float, float, float, float]]:
    """Return every extent reported by ogrinfo, in file order."""
    return [
        (float(a), float(b), float(c), float(d))
        for a, b, c, d in (match.groups() for match in EXTENT_RE.finditer(text))
    ]


def union_extent(
    extents: list[tuple[float, float, float, float]],
) -> tuple[float, float, float, float]:
    """Combine per-layer extents into the envelope covering all of them."""
    return (
        min(extent[0] for extent in extents),
        min(extent[1] for extent in extents),
        max(extent[2] for extent in extents),
        max(extent[3] for extent in extents),
    )


def aoi_extent(aoi_path: Path, gdal_bin: Path | None) -> tuple[float, float, float, float]:
    """Return (minx, miny, maxx, maxy) covering every layer of the AOI file.

    The AOI file must already be in the CRS you intend to query the
    service with (reproject first with ogr2ogr if needed).
    """
    if not aoi_path.exists():
        raise FetchError(f"AOI file not found: {aoi_path}")
    try:
        completed = subprocess.run(
            [tool("ogrinfo", gdal_bin), "-al", "-so", str(aoi_path)],
            check=True,
            capture_output=True,
            text=True,
            env=gdal_env(gdal_bin),
        )
    except FileNotFoundError as exc:
        raise FetchError(
            "ogrinfo not found. Put the GDAL binaries on PATH or pass --gdal-bin."
        ) from exc
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or exc.stdout or "").strip()
        raise FetchError(f"ogrinfo could not read {aoi_path}: {detail[:500]}") from exc

    extents = parse_extents(completed.stdout)
    if not extents:
        raise FetchError(f"Could not parse extent from ogrinfo output for {aoi_path}")
    minx, miny, maxx, maxy = union_extent(extents)
    if not all(math.isfinite(value) for value in (minx, miny, maxx, maxy)):
        raise FetchError(f"The AOI extent of {aoi_path} is not a finite rectangle.")
    if maxx <= minx or maxy <= miny:
        raise FetchError(
            f"The AOI in {aoi_path} has an empty extent - check the file contains geometries."
        )
    return minx, miny, maxx, maxy


def http_get(url: str, destination: Path | None, attempts: int, timeout: int) -> bytes | None:
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        temp = destination.with_suffix(destination.suffix + ".part") if destination else None
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=timeout) as response:
                if destination is None or temp is None:
                    return response.read()
                with temp.open("wb") as fh:
                    first_chunk = response.read(4096)
                    content_type = response.headers.get_content_type().lower()
                    if (
                        content_type in {"text/xml", "application/xml", "text/html"}
                        or b"ServiceException" in first_chunk
                    ):
                        detail = first_chunk.decode("utf-8", errors="replace").strip()
                        raise FetchError(
                            "Server returned an OGC/service error instead of raster data: "
                            f"{detail[:500]}"
                        )
                    fh.write(first_chunk)
                    while chunk := response.read(1024 * 1024):
                        fh.write(chunk)
                temp.replace(destination)
                return None
        except urllib.error.HTTPError as exc:
            last_error = exc
            if exc.code not in RETRYABLE_STATUSES:
                detail = ""
                try:
                    detail = exc.read(500).decode("utf-8", errors="replace").strip()
                except Exception:  # noqa: BLE001 - body is best-effort context only
                    pass
                raise FetchError(
                    f"HTTP {exc.code} {exc.reason} for {url}. {detail}".strip()
                ) from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last_error = exc
        finally:
            # Never leave a half-written .part behind for the next run to trip on.
            if temp is not None and temp.exists():
                temp.unlink(missing_ok=True)
        if attempt < attempts:
            time.sleep(min(30, 3 * attempt))
    raise FetchError(f"Request failed after {attempts} attempts: {url} ({last_error})")


def relay_screenshot_url(
    get_map_url: str, width: int, height: int, attempts: int, timeout: int
) -> str:
    """Render a WMS GetMap URL through a screenshot API and return the image URL.

    Useful when the WMS server blocks direct requests from your network
    (e.g. geo-fencing) but still serves normal browser traffic. Only usable
    for image formats (PNG/JPEG), never for raw WCS data.
    """
    relay_params = {
        "url": get_map_url,
        "screenshot": "true",
        "meta": "false",
        "viewport.width": str(width),
        "viewport.height": str(height),
        "viewport.deviceScaleFactor": "1",
    }
    relay_url = "https://api.microlink.io/?" + urllib.parse.urlencode(relay_params)
    payload_bytes = http_get(relay_url, None, attempts, timeout)
    try:
        return json.loads(payload_bytes or b"")["data"]["screenshot"]["url"]
    except (ValueError, KeyError, TypeError) as exc:
        raise FetchError("The screenshot relay did not return an image URL.") from exc


def remove_paths(paths: list[Path]) -> None:
    for path in paths:
        if path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
        else:
            path.unlink(missing_ok=True)


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
            str(raw),
            str(clipped),
        ],
        args.gdal_bin,
    )
    if args.cleanup:
        remove_paths([raw])
    return clipped


def tile_grid(
    minx: float,
    miny: float,
    maxx: float,
    maxy: float,
    tile_w: int,
    tile_h: int,
    resolution: float,
) -> tuple[int, int]:
    """Return (cols, rows) of GetMap tiles needed to cover the extent."""
    cols = max(1, math.ceil((maxx - minx) / (tile_w * resolution)))
    rows = max(1, math.ceil((maxy - miny) / (tile_h * resolution)))
    return cols, rows


def fetch_wms(args: argparse.Namespace) -> Path:
    minx, miny, maxx, maxy = aoi_extent(Path(args.aoi), args.gdal_bin)
    tile_w, tile_h = args.tile_size
    cols, rows = tile_grid(minx, miny, maxx, maxy, tile_w, tile_h, args.resolution)

    total = cols * rows
    if total > args.max_tiles:
        raise FetchError(
            f"This AOI needs {total} tiles at {args.resolution} units/pixel "
            f"(limit --max-tiles {args.max_tiles}). Use a smaller AOI, a coarser "
            "--resolution, or a larger --tile-size."
        )

    # Keep resumable tile caches separate when several outputs share a folder.
    tiles_dir = Path(args.out).parent / f"{Path(args.out).stem}_tiles"
    tiles_dir.mkdir(parents=True, exist_ok=True)
    tif_paths: list[Path] = []

    index = 0
    digits = len(str(total))
    for row in range(rows):
        tymax = maxy - row * tile_h * args.resolution
        tymin = max(miny, tymax - tile_h * args.resolution)
        # A trailing row/column can be thinner than one pixel; never ask the
        # server for a 0-pixel image.
        height = max(1, round((tymax - tymin) / args.resolution))
        for col in range(cols):
            index += 1
            txmin = minx + col * tile_w * args.resolution
            txmax = min(maxx, txmin + tile_w * args.resolution)
            width = max(1, round((txmax - txmin) / args.resolution))

            stem = f"tile_r{row:03d}_c{col:03d}"
            image = tiles_dir / f"{stem}.{args.image_ext}"
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
                    target_url = relay_screenshot_url(
                        get_map_url, width, height, args.retries, args.timeout
                    )

                print(f"[{index:0{digits}d}/{total}] {stem} {width}x{height}", flush=True)
                http_get(target_url, image, attempts=args.retries, timeout=args.timeout)
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
                        str(image),
                        str(tif),
                    ],
                    args.gdal_bin,
                )
                # The georeferenced .tif supersedes the raw download.
                image.unlink(missing_ok=True)
            tif_paths.append(tif)

    # Pass the tile list through a file: thousands of paths overflow the
    # Windows command line (~32k characters).
    vrt = Path(args.out).with_suffix(".vrt")
    tile_list = tiles_dir / "tiles.txt"
    tile_list.write_text("\n".join(str(path) for path in tif_paths), encoding="utf-8")
    run(
        [
            tool("gdalbuildvrt", args.gdal_bin),
            "-overwrite",
            "-input_file_list",
            str(tile_list),
            str(vrt),
        ],
        args.gdal_bin,
    )

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
    if args.cleanup:
        remove_paths([vrt, mosaic, tiles_dir])
    return clipped


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--service", choices=["wms", "wcs"], required=True)
    parser.add_argument("--url", required=True, help="Base WMS/WCS endpoint URL")
    parser.add_argument("--layer", required=True, help="WMS layer name or WCS coverage id")
    parser.add_argument(
        "--aoi",
        required=True,
        help="Vector file (any GDAL/OGR format) defining the area of interest, already in --crs",
    )
    parser.add_argument("--crs", required=True, help="e.g. EPSG:31982")
    parser.add_argument(
        "--resolution",
        type=float,
        default=1.0,
        help="Output resolution in CRS units per pixel (default: 1)",
    )
    parser.add_argument("--out", required=True, help="Output GeoTIFF path")
    parser.add_argument(
        "--format",
        default=None,
        help="WMS image format (default image/png) or WCS format (default GeoTIFF)",
    )
    parser.add_argument(
        "--tile-size",
        type=int,
        nargs=2,
        default=[1024, 1024],
        metavar=("WIDTH", "HEIGHT"),
        help="WMS tile size in pixels (default: 1024 1024)",
    )
    parser.add_argument(
        "--max-tiles",
        type=int,
        default=4096,
        help="Refuse WMS jobs needing more tiles than this (default: 4096)",
    )
    parser.add_argument(
        "--image-ext",
        default="png",
        help="File extension for downloaded WMS tiles (default: png)",
    )
    parser.add_argument("--wms-version", choices=["1.1.1", "1.3.0"], default="1.1.1")
    parser.add_argument(
        "--wcs-version", choices=["1.0.0"], default="1.0.0", help="WCS 1.0.0 GetCoverage version"
    )
    parser.add_argument(
        "--relay",
        choices=["none", "microlink"],
        default="none",
        help="Fetch WMS tiles through a screenshot relay (see README). Never applies to WCS.",
    )
    parser.add_argument(
        "--cleanup",
        action="store_true",
        help="Delete intermediates (_RAW/_MOSAIC/.vrt/tile cache) once the clipped output exists",
    )
    parser.add_argument(
        "--gdal-bin",
        type=Path,
        default=None,
        help="Directory containing GDAL binaries, if not on PATH",
    )
    parser.add_argument("--retries", type=int, default=5)
    parser.add_argument("--timeout", type=int, default=180)
    args = parser.parse_args(argv)
    if not math.isfinite(args.resolution) or args.resolution <= 0:
        parser.error("--resolution must be a finite number greater than zero")
    if any(value <= 0 for value in args.tile_size):
        parser.error("--tile-size values must be greater than zero")
    if args.max_tiles < 1:
        parser.error("--max-tiles must be at least 1")
    if args.retries < 1:
        parser.error("--retries must be at least 1")
    if args.timeout < 1:
        parser.error("--timeout must be at least 1")
    if args.relay != "none" and args.service == "wcs":
        parser.error("--relay only applies to --service wms: a screenshot relay corrupts WCS values")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    try:
        result = fetch_wcs(args) if args.service == "wcs" else fetch_wms(args)
    except FetchError as error:
        print(f"error: {error}", file=sys.stderr, flush=True)
        return 1
    except KeyboardInterrupt:
        print("error: interrupted", file=sys.stderr, flush=True)
        return 130
    print(f"OUTPUT={result}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
