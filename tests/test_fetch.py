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


if __name__ == "__main__":
    unittest.main()
