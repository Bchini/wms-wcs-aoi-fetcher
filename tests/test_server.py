import importlib.util
import sys
import unittest
from pathlib import Path
from xml.etree import ElementTree

ROOT = Path(__file__).parents[1]

# fetch.py must be importable as "fetch" before container/server.py is loaded,
# exactly like the container's own sys.path setup does at import time.
FETCH_SPEC = importlib.util.spec_from_file_location("fetch", ROOT / "fetch.py")
fetch_module = importlib.util.module_from_spec(FETCH_SPEC)
sys.modules["fetch"] = fetch_module
FETCH_SPEC.loader.exec_module(fetch_module)

SERVER_SPEC = importlib.util.spec_from_file_location("server", ROOT / "container" / "server.py")
server = importlib.util.module_from_spec(SERVER_SPEC)
sys.modules["server"] = server  # @dataclass needs the module registered to resolve type hints
SERVER_SPEC.loader.exec_module(server)

WMS_CAPABILITIES = """<?xml version="1.0"?>
<WMS_Capabilities version="1.3.0" xmlns="http://www.opengis.net/wms">
  <Service><Name>WMS</Name></Service>
  <Capability>
    <Layer>
      <Layer>
        <Name>demo:layer_a</Name>
        <BoundingBox CRS="EPSG:4326" minx="27" miny="-19" maxx="44" maxy="5"/>
        <BoundingBox SRS="EPSG:25830" minx="100000" miny="4000000" maxx="200000" maxy="4100000"/>
        <Style><Name>default</Name></Style>
      </Layer>
    </Layer>
  </Capability>
</WMS_Capabilities>
"""

WCS_CAPABILITIES = """<?xml version="1.0"?>
<WCS_Capabilities version="1.0.0" xmlns="http://www.opengis.net/wcs">
  <ContentMetadata>
    <CoverageOfferingBrief>
      <name>demo:coverage_a</name>
      <lonLatEnvelope>
        <pos>-10 30</pos>
        <pos>10 50</pos>
      </lonLatEnvelope>
    </CoverageOfferingBrief>
  </ContentMetadata>
</WCS_Capabilities>
"""


class AxisOrderTests(unittest.TestCase):
    def test_wms_13_epsg4326_boundingbox_is_unswapped_to_lon_lat(self):
        layer = ElementTree.fromstring(
            '<Layer xmlns="http://www.opengis.net/wms">'
            '<Name>x</Name>'
            '<BoundingBox CRS="EPSG:4326" minx="27" miny="-19" maxx="44" maxy="5"/>'
            "</Layer>"
        )
        bounds, crs = server.box_from_element(layer, "EPSG:4326")
        # minx/miny in the XML are latitude/longitude (WMS 1.3 axis order);
        # the returned tuple must be standard (lon_min, lat_min, lon_max, lat_max).
        self.assertEqual(bounds, (-19.0, 27.0, 5.0, 44.0))
        self.assertEqual(crs, "EPSG:4326")

    def test_wms_11_srs_boundingbox_is_not_swapped(self):
        layer = ElementTree.fromstring(
            '<Layer xmlns="http://www.opengis.net/wms">'
            '<Name>x</Name>'
            '<BoundingBox SRS="EPSG:4326" minx="-19" miny="27" maxx="5" maxy="44"/>'
            "</Layer>"
        )
        bounds, _ = server.box_from_element(layer, "EPSG:4326")
        self.assertEqual(bounds, (-19.0, 27.0, 5.0, 44.0))

    def test_projected_crs_boundingbox_is_never_swapped(self):
        layer = ElementTree.fromstring(
            '<Layer xmlns="http://www.opengis.net/wms">'
            '<Name>x</Name>'
            '<BoundingBox CRS="EPSG:25830" minx="100000" miny="4000000" maxx="200000" maxy="4100000"/>'
            "</Layer>"
        )
        bounds, _ = server.box_from_element(layer, "EPSG:25830")
        self.assertEqual(bounds, (100000.0, 4000000.0, 200000.0, 4100000.0))

    def test_wms_111_latlonboundingbox_is_lon_lat_order(self):
        layer = ElementTree.fromstring(
            '<Layer xmlns="http://www.opengis.net/wms">'
            '<Name>x</Name>'
            '<LatLonBoundingBox minx="-19" miny="27" maxx="5" maxy="44"/>'
            "</Layer>"
        )
        bounds, crs = server.box_from_element(layer, "EPSG:9999")  # no CRS-specific match needed
        self.assertEqual(bounds, (-19.0, 27.0, 5.0, 44.0))
        self.assertEqual(crs, "EPSG:4326")


class LayerDiscoveryTests(unittest.TestCase):
    def test_first_layer_name_skips_nameless_container_layer(self):
        root = ElementTree.fromstring(WMS_CAPABILITIES)
        self.assertEqual(server.first_layer_name(root, "wms"), "demo:layer_a")

    def test_first_layer_name_reads_wcs_coverage_brief(self):
        root = ElementTree.fromstring(WCS_CAPABILITIES)
        self.assertEqual(server.first_layer_name(root, "wcs"), "demo:coverage_a")

    def test_advertised_bounds_finds_the_requested_crs(self):
        root = ElementTree.fromstring(WMS_CAPABILITIES)
        for element in root.iter():
            if server.layer_identifier(element, "wms") == "demo:layer_a":
                bounds, crs = server.box_from_element(element, "EPSG:25830")
                self.assertEqual(bounds, (100000.0, 4000000.0, 200000.0, 4100000.0))
                self.assertEqual(crs, "EPSG:25830")
                break
        else:
            self.fail("layer not found")


class QueryParsingTests(unittest.TestCase):
    def test_query_params_upper_cases_keys(self):
        params = server.query_params("https://example.test/wms?Service=WMS&version=1.3.0")
        self.assertEqual(params, {"SERVICE": "WMS", "VERSION": "1.3.0"})

    def test_endpoint_only_strips_query_string(self):
        self.assertEqual(
            server.endpoint_only("https://example.test/geoserver/wms?service=WMS&request=GetMap"),
            "https://example.test/geoserver/wms",
        )

    def test_guess_service_from_path(self):
        self.assertEqual(server.guess_service_from_path("https://example.test/geoserver/wcs"), "wcs")
        self.assertEqual(server.guess_service_from_path("https://example.test/wmts?a=b"), "wmts")
        self.assertEqual(server.guess_service_from_path("https://example.test/geoserver/wms"), "wms")
        self.assertIsNone(server.guess_service_from_path("https://example.test/geoserver"))


class PixelBudgetTests(unittest.TestCase):
    def test_guard_pixel_budget_rejects_oversized_requests(self):
        with self.assertRaises(server.HTTPException):
            server.guard_pixel_budget((0, 0, 100000, 100000), 1)

    def test_guard_pixel_budget_allows_reasonable_requests(self):
        server.guard_pixel_budget((0, 0, 10, 10), 0.01)  # should not raise


class InterpretUrlTests(unittest.TestCase):
    """interpret_url() exercised against local synthetic capabilities via a
    stubbed capabilities_document(), so these run with no network access.
    """

    def setUp(self):
        self._original = server.capabilities_document
        self._docs = {
            ("wms", "1.3.0"): ElementTree.fromstring(WMS_CAPABILITIES),
            ("wcs", "1.0.0"): ElementTree.fromstring(WCS_CAPABILITIES),
        }

        def fake_capabilities_document(endpoint, service, version):
            key = (service, version)
            if key in self._docs:
                return self._docs[key]
            raise server.HTTPException(422, "no capabilities")

        server.capabilities_document = fake_capabilities_document

    def tearDown(self):
        server.capabilities_document = self._original

    def test_full_url_with_bbox_is_used_literally(self):
        resolved = server.interpret_url(
            "https://example.test/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap"
            "&LAYERS=demo:layer_a&CRS=EPSG:4326&BBOX=40,-4,41,-3&WIDTH=1000&HEIGHT=1000",
            Path("."),
        )
        self.assertEqual(resolved.service, "wms")
        self.assertEqual(resolved.layer, "demo:layer_a")
        self.assertEqual(resolved.bounds, (-4.0, 40.0, -3.0, 41.0))
        self.assertAlmostEqual(resolved.resolution, 0.001)

    def test_bare_capabilities_url_falls_back_to_full_extent(self):
        resolved = server.interpret_url(
            "https://example.test/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetCapabilities",
            Path("."),
        )
        self.assertEqual(resolved.layer, "demo:layer_a")
        self.assertEqual(resolved.bounds, (-19.0, 27.0, 5.0, 44.0))
        self.assertGreater(resolved.resolution, 0)

    def test_unknown_version_falls_back_to_default(self):
        resolved = server.interpret_url(
            "https://example.test/wms?SERVICE=WMS&VERSION=9.9.9&REQUEST=GetCapabilities",
            Path("."),
        )
        self.assertEqual(resolved.version, "1.3.0")

    def test_surrounding_whitespace_is_stripped_consistently(self):
        # A stray leading/trailing space (a careless paste) must not survive
        # into the endpoint used for the capabilities/GetMap request.
        resolved = server.interpret_url(
            "  https://example.test/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetCapabilities  ",
            Path("."),
        )
        self.assertEqual(resolved.endpoint, "https://example.test/wms")


if __name__ == "__main__":
    unittest.main()
