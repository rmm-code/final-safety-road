"""Detector selection and the determinism of the synthetic detector."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import numpy as np
import pytest

from ai.inference.detector import MOCK_MODEL_VERSION, MockDetector, create_detector
from ai.inference.prng import create_prng
from ai.inference.severity import VisualSeverityEngine
from ai.inference.tracking import TrackManager, visible_area
from ai.inference.types import Detection

BLANK = np.zeros((180, 320, 3), dtype=np.uint8)


def sequence(detector: MockDetector, frames: int) -> list[list]:
    return [detector.detect(BLANK) for _ in range(frames)]


class TestPrng:
    def test_is_bit_compatible_with_the_browser_implementation(self):
        # Reference values produced by packages/vision-web/src/util/prng.ts with seed 1.
        rand = create_prng(1)
        assert [f"{rand():.12f}" for _ in range(3)] == [
            "0.627073940588",
            "0.002735721180",
            "0.527447039960",
        ]

    def test_is_reproducible(self):
        a, b = create_prng(42), create_prng(42)
        assert [a() for _ in range(10)] == [b() for _ in range(10)]


class TestMockDetector:
    def test_declares_itself_synthetic(self, config):
        info = MockDetector(config).info
        assert info.is_synthetic is True
        assert info.kind == "mock"
        assert info.model_version.startswith("mock-")
        assert info.model_version == MOCK_MODEL_VERSION

    def test_is_deterministic_for_a_given_seed(self, config):
        assert sequence(MockDetector(config), 60) == sequence(MockDetector(config), 60)

    def test_differs_for_a_different_seed(self, config):
        assert sequence(MockDetector(config, seed=1), 60) != sequence(
            MockDetector(config, seed=2), 60
        )

    def test_emits_boxes_inside_the_frame(self, config):
        for frame in sequence(MockDetector(config), 200):
            for detection in frame:
                box = detection.bbox
                assert box.x >= 0 and box.y >= 0
                assert box.x + box.width <= 1 + 1e-9
                assert box.y + box.height <= 1 + 1e-9
                assert 0 < detection.confidence <= 1


class TestSelection:
    def test_falls_back_to_the_synthetic_detector_and_warns(self, config, capsys):
        detector = create_detector(config, None)
        captured = capsys.readouterr()
        assert detector.info.is_synthetic is True
        assert "SYNTHETIC" in captured.err

    def test_fails_loudly_when_the_model_is_missing(self, config, tmp_path):
        with pytest.raises(FileNotFoundError):
            create_detector(config, tmp_path / "missing.onnx")


class TestSyntheticPipeline:
    def test_collapses_many_detections_into_few_potholes(self, config):
        """Pipeline sanity check, not a measure of detection quality: input is fabricated."""
        detector = MockDetector(config)
        tracker = TrackManager(config)
        severity_engine = VisualSeverityEngine(config)
        frame_ms = 1000 / config.sample_fps
        frames = int(config.sample_fps * 120)

        raw = 0
        for index in range(frames):
            detections = detector.detect(BLANK)
            raw += len(detections)
            tracker.update(detections, timestamp_ms=index * frame_ms, frame_index=index)
        tracker.flush()

        finalized = tracker.take_finalized_tracks()
        assert len(finalized) > 5
        assert len(finalized) < raw / 3

        levels = {severity_engine.calculate(track).level for track in finalized}
        assert {"small", "medium", "large"} <= levels
        assert "unknown" not in levels

        for track in finalized:
            assert len(track.observations) >= config.tracking.min_observations
            assert track.max_confidence >= config.tracking.min_max_confidence
            assert track.state == "FINALIZED"


class TestModelFormatDispatch:
    """Selection is by file extension, so the documented commands work verbatim."""

    def test_rejects_an_unsupported_model_format(self, config, tmp_path):
        model = tmp_path / "model.tflite"
        model.write_bytes(b"stub")
        with pytest.raises(ValueError, match="Unsupported model format"):
            create_detector(config, model)

    def test_reports_a_missing_model_rather_than_falling_back_to_synthetic(self, config, tmp_path):
        # Falling back silently would present fabricated output as a model reading.
        with pytest.raises(FileNotFoundError):
            create_detector(config, tmp_path / "pothole-detector.pt")


@pytest.mark.skipif(
    importlib.util.find_spec("ultralytics") is None,
    reason="ultralytics is an optional dependency; install ai/requirements-model.txt",
)
class TestUltralyticsAdapter:
    """The adapter converts Ultralytics results into our schema and nothing else escapes."""

    def test_normalises_results_into_our_detection_schema(self, config, monkeypatch):
        from ai.inference import detector as detector_module

        detections = _run_adapter_against(
            detector_module,
            monkeypatch,
            config,
            names={0: "pothole"},
            xyxyn=[[0.25, 0.5, 0.45, 0.7]],
            conf=[0.87],
            cls=[0],
        )

        assert len(detections) == 1
        assert detections[0].class_name == "pothole"
        assert detections[0].confidence == pytest.approx(0.87)
        assert detections[0].bbox.x == pytest.approx(0.25)
        assert detections[0].bbox.width == pytest.approx(0.2)
        assert isinstance(detections[0], Detection)

    def test_matches_the_pothole_class_by_name_not_index(self, config, monkeypatch):
        from ai.inference import detector as detector_module

        # A third-party checkpoint may put pothole at any index, next to other classes.
        detections = _run_adapter_against(
            detector_module,
            monkeypatch,
            config,
            names={0: "crack", 1: "Pothole", 2: "manhole"},
            xyxyn=[[0.1, 0.1, 0.2, 0.2], [0.3, 0.5, 0.5, 0.7], [0.6, 0.6, 0.7, 0.7]],
            conf=[0.9, 0.8, 0.95],
            cls=[0, 1, 2],
        )

        assert len(detections) == 1
        assert detections[0].class_id == 1

    def test_carries_the_segmentation_contour_through(self, config, monkeypatch):
        from ai.inference import detector as detector_module

        contour = [[0.25, 0.5], [0.45, 0.5], [0.45, 0.7], [0.25, 0.7]]
        detections = _run_adapter_against(
            detector_module,
            monkeypatch,
            config,
            names={0: "pothole"},
            xyxyn=[[0.25, 0.5, 0.45, 0.7]],
            conf=[0.87],
            cls=[0],
            masks=[contour],
        )

        assert detections[0].polygon is not None
        assert len(detections[0].polygon) == 4
        # A square mask has the same area as its box; an irregular one would be smaller.
        assert visible_area(detections[0]) == pytest.approx(0.04, abs=1e-6)

    def test_accepts_the_rdd2022_pothole_label(self, config, monkeypatch):
        from ai.inference import detector as detector_module

        # RDD2022 calls a pothole "D40" and puts crack types at indices 0-2. Matching by
        # position rather than name would report longitudinal cracks as potholes.
        detections = _run_adapter_against(
            detector_module,
            monkeypatch,
            config,
            names={0: "D00", 1: "D10", 2: "D20", 3: "D40", 4: "Repair"},
            xyxyn=[[0.1, 0.1, 0.2, 0.2], [0.3, 0.5, 0.5, 0.7]],
            conf=[0.95, 0.8],
            cls=[0, 3],
        )
        assert len(detections) == 1
        assert detections[0].class_id == 3

    def test_refuses_a_checkpoint_without_a_pothole_class(self, config, monkeypatch):
        from ai.inference import detector as detector_module

        with pytest.raises(ValueError, match="exposes no pothole class"):
            _run_adapter_against(
                detector_module,
                monkeypatch,
                config,
                names={0: "car", 1: "person"},
                xyxyn=[],
                conf=[],
                cls=[],
            )


class _FakeTensor:
    """Stands in for the torch tensors Ultralytics returns."""

    def __init__(self, values):
        self._values = np.asarray(values, dtype=np.float32)

    def cpu(self):
        return self

    def numpy(self):
        return self._values

    def __iter__(self):
        return iter(self._values)

    def __len__(self):
        return len(self._values)


class _FakeBoxes:
    def __init__(self, xyxyn, conf, cls):
        self.xyxyn = _FakeTensor(xyxyn if len(xyxyn) else np.zeros((0, 4)))
        self.conf = _FakeTensor(conf)
        self.cls = _FakeTensor(cls)

    def __len__(self):
        return len(self.conf)


class _FakeMasks:
    def __init__(self, contours):
        self.xyn = [np.asarray(c, dtype=np.float32) for c in contours]


class _FakeResult:
    def __init__(self, boxes, masks):
        self.boxes = boxes
        self.masks = masks


class _FakeYolo:
    """Minimal stand-in for ultralytics.YOLO, so the adapter is tested without weights."""

    def __init__(self, names, result, task="segment"):
        self.names = names
        self.task = task
        self._result = result
        self.predict_kwargs = None

    def predict(self, _frame, **kwargs):
        self.predict_kwargs = kwargs
        return [self._result]


def _run_adapter_against(detector_module, monkeypatch, config, names, xyxyn, conf, cls, masks=None):
    """Build an UltralyticsDetector over a fake YOLO and return its normalised output."""
    result = _FakeResult(_FakeBoxes(xyxyn, conf, cls), _FakeMasks(masks) if masks else None)
    fake = _FakeYolo(names, result)

    import sys
    import types

    module = types.ModuleType("ultralytics")
    module.YOLO = lambda _path: fake
    monkeypatch.setitem(sys.modules, "ultralytics", module)

    detector = detector_module.UltralyticsDetector(Path("models/fake.pt"), config)
    detections = detector.detect(np.zeros((180, 320, 3), dtype=np.uint8))

    # Predict arguments must come from configuration, never be hard-coded.
    assert fake.predict_kwargs["conf"] == config.detection.confidence_threshold
    assert fake.predict_kwargs["iou"] == config.detection.nms_iou_threshold
    assert fake.predict_kwargs["imgsz"] == config.model.input_size
    assert fake.predict_kwargs["verbose"] is False
    return detections


class TestCheckpointVersion:
    """A `.pt` checkpoint takes its version from the manifest that names it."""

    def test_reads_name_and_version_for_the_named_checkpoint(self, tmp_path):
        from ai.inference.detector import checkpoint_version

        (tmp_path / "model.json").write_text(
            '{"name": "pothole-road-anomaly", "version": "1.0.0", "checkpoint": "weights.pt"}'
        )
        assert checkpoint_version(tmp_path / "weights.pt") == "pothole-road-anomaly-1.0.0"

    def test_ignores_a_manifest_for_another_file(self, tmp_path):
        from ai.inference.detector import checkpoint_version

        # The stale case that caused this: a manifest left over from a rejected model.
        (tmp_path / "model.json").write_text(
            '{"name": "old", "version": "0.1.0", "file": "old-0.1.0.onnx"}'
        )
        assert checkpoint_version(tmp_path / "weights.pt") is None

    def test_no_manifest_means_no_version(self, tmp_path):
        from ai.inference.detector import checkpoint_version

        assert checkpoint_version(tmp_path / "weights.pt") is None
