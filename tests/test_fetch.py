import importlib.util
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("fetch", Path(__file__).parents[1] / "fetch.py")
fetch = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fetch)


class WmsProtocolTests(unittest.TestCase):
    def test_wms_130_epsg_4326_uses_latitude_first(self):
        self.assertEqual(fetch.wms_bbox(1, 2, 3, 4, "EPSG:4326", "1.3.0"), "2,1,4,3")

    def test_wms_111_keeps_easting_first(self):
        self.assertEqual(fetch.wms_bbox(1, 2, 3, 4, "EPSG:4326", "1.1.1"), "1,2,3,4")

    def test_wms_parameter_matches_version(self):
        self.assertEqual(fetch.wms_crs_parameter("1.3.0"), "crs")
        self.assertEqual(fetch.wms_crs_parameter("1.1.1"), "srs")

    def test_endpoint_with_query_is_extended_safely(self):
        self.assertEqual(fetch.service_url("https://example.test/wms?token=x", {"request": "GetMap"}), "https://example.test/wms?token=x&request=GetMap")

    def test_bbox_param_to_geographic_is_the_inverse_of_wms_bbox(self):
        minx, miny, maxx, maxy = 1.0, 2.0, 3.0, 4.0
        wire = fetch.wms_bbox(minx, miny, maxx, maxy, "EPSG:4326", "1.3.0")
        values = tuple(float(v) for v in wire.split(","))
        self.assertEqual(
            fetch.bbox_param_to_geographic(values, "EPSG:4326", "1.3.0"), (minx, miny, maxx, maxy)
        )

    def test_bbox_param_to_geographic_leaves_non_4326_alone(self):
        values = (1.0, 2.0, 3.0, 4.0)
        self.assertEqual(fetch.bbox_param_to_geographic(values, "EPSG:31982", "1.3.0"), values)
        self.assertEqual(fetch.bbox_param_to_geographic(values, "EPSG:4326", "1.1.1"), values)


class ExtentParsingTests(unittest.TestCase):
    def test_parses_single_layer_extent(self):
        ogrinfo_output = "Layer name: aoi\nExtent: (100.500, 200.250) - (300.750, 400.125)\n"
        self.assertEqual(fetch.parse_extents(ogrinfo_output), [(100.5, 200.25, 300.75, 400.125)])

    def test_parses_scientific_notation(self):
        ogrinfo_output = "Extent: (6.4e+05, -2.31e+06) - (6.5e+05, -2.30e+06)\n"
        self.assertEqual(fetch.parse_extents(ogrinfo_output), [(6.4e5, -2.31e6, 6.5e5, -2.30e6)])

    def test_union_extent_covers_every_layer(self):
        extents = [(0, 0, 10, 10), (-5, 2, 8, 20)]
        self.assertEqual(fetch.union_extent(extents), (-5, 0, 10, 20))


class TileGridTests(unittest.TestCase):
    def test_exact_multiple_of_tile_size(self):
        self.assertEqual(fetch.tile_grid(0, 0, 2048, 1024, 1024, 1024, 1), (2, 1))

    def test_partial_trailing_tile_rounds_up(self):
        self.assertEqual(fetch.tile_grid(0, 0, 100, 100, 1024, 1024, 1), (1, 1))

    def test_never_returns_zero_tiles_for_a_nonempty_extent(self):
        self.assertEqual(fetch.tile_grid(0, 0, 0.5, 0.5, 1024, 1024, 1), (1, 1))


class ArgParsingTests(unittest.TestCase):
    def test_relay_is_rejected_for_wcs(self):
        argv = [
            "--service", "wcs", "--url", "https://example.test/wcs", "--layer", "x",
            "--aoi", "aoi.gpkg", "--crs", "EPSG:4326", "--out", "out.tif",
            "--relay", "microlink",
        ]
        with self.assertRaises(SystemExit):
            fetch.parse_args(argv)

    def test_non_positive_resolution_is_rejected(self):
        argv = [
            "--service", "wcs", "--url", "https://example.test/wcs", "--layer", "x",
            "--aoi", "aoi.gpkg", "--crs", "EPSG:4326", "--out", "out.tif",
            "--resolution", "0",
        ]
        with self.assertRaises(SystemExit):
            fetch.parse_args(argv)


if __name__ == "__main__":
    unittest.main()
