"""Detector implementations and selection.

Mirrors the browser's VisionEngine abstraction: the pipeline depends on this interface,
never on a model runtime or a particular output format.
"""

from __future__ import annotations

import json
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

import numpy as np

from ai.inference.config import VisionConfig
from ai.inference.geometry import BoundingBox
from ai.inference.postprocess import OutputLayout, compute_letterbox, decode_detections
from ai.inference.prng import create_prng, random_between
from ai.inference.types import POTHOLE_CLASS_ALIASES, Detection, is_pothole_class

MOCK_MODEL_VERSION = "mock-synthetic-0.1.0"


@dataclass(frozen=True, slots=True)
class DetectorInfo:
    kind: str
    model_version: str
    backend: str
    is_synthetic: bool
    selection_reason: str


class Detector(Protocol):
    @property
    def info(self) -> DetectorInfo: ...

    @property
    def other_class_counts(self) -> dict[str, int]:
        """Confident detections recognised but not reported, by class name.

        Observability only: nothing downstream may turn these into potholes.
        """
        ...

    def detect(self, frame: np.ndarray) -> list[Detection]:
        """Detect potholes in a BGR frame and return normalised detections."""
        ...

    def close(self) -> None: ...


class OnnxDetector:
    """Runs an exported ONNX detector with onnxruntime."""

    def __init__(
        self,
        model_path: Path,
        config: VisionConfig,
        model_version: str | None = None,
        layout: OutputLayout = "auto",
        mask_coefficients: int = 0,
        class_names: Sequence[str] | None = None,
        providers: list[str] | None = None,
    ) -> None:
        import onnxruntime as ort  # imported lazily so the CLI starts without a model

        self._config = config
        self._layout = layout
        self._mask_coefficients = mask_coefficients
        # The MODEL's class list, not the pipeline default: a multi-class checkpoint
        # emits 4 + n channels, and decoding it against the wrong n reads every score
        # from the wrong offset.
        self._class_names = tuple(class_names) if class_names else config.model.class_names
        self._session = ort.InferenceSession(
            str(model_path),
            providers=providers or ort.get_available_providers(),
        )
        self._input_name = self._session.get_inputs()[0].name
        # The graph is the authority on input size: Ultralytics runs inference
        # rectangularly (e.g. 384x640 for 16:9), and a square assumption would letterbox
        # away almost half the tensor and detect noticeably less.
        shape = self._session.get_inputs()[0].shape
        self._input_height = int(shape[2]) if isinstance(shape[2], int) else config.model.input_size
        self._input_width = int(shape[3]) if isinstance(shape[3], int) else config.model.input_size
        self._other_classes: dict[str, int] = {}
        self._info = DetectorInfo(
            kind="onnx",
            model_version=model_version or model_path.stem,
            backend=self._session.get_providers()[0],
            is_synthetic=False,
            selection_reason=f"ONNX model loaded from {model_path}",
        )

    @property
    def info(self) -> DetectorInfo:
        return self._info

    def detect(self, frame: np.ndarray) -> list[Detection]:
        import cv2

        height, width = frame.shape[:2]
        transform = compute_letterbox(width, height, self._input_width, self._input_height)

        resized = cv2.resize(
            frame,
            (int(round(width * transform.scale)), int(round(height * transform.scale))),
            interpolation=cv2.INTER_LINEAR,
        )
        canvas = np.full((self._input_height, self._input_width, 3), 114, dtype=np.uint8)
        top, left = int(transform.pad_y), int(transform.pad_x)
        canvas[top : top + resized.shape[0], left : left + resized.shape[1]] = resized

        rgb = cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        tensor = np.transpose(rgb, (2, 0, 1))[np.newaxis, ...]

        outputs = self._session.run(None, {self._input_name: tensor})
        return decode_detections(
            np.asarray(outputs[0]),
            self._class_names,
            self._config.detection.confidence_threshold,
            self._config.detection.nms_iou_threshold,
            self._config.detection.max_detections,
            transform,
            self._layout,
            self._mask_coefficients,
            on_skipped_class=self._count_other,
        )

    def _count_other(self, name: str) -> None:
        self._other_classes[name] = self._other_classes.get(name, 0) + 1

    @property
    def other_class_counts(self) -> dict[str, int]:
        return dict(self._other_classes)

    def close(self) -> None:
        self._session = None  # type: ignore[assignment]


class UltralyticsDetector:
    """Adapter for an Ultralytics checkpoint (`.pt`).

    This class is the AI adapter boundary: Ultralytics `Results` objects are converted to
    our own `Detection` schema here and never escape. Everything downstream - tracking,
    severity, reporting - depends only on that schema, so swapping the detector is a
    change to this file alone.

    Works with detection and segmentation checkpoints. For a segmentation model the
    normalised mask contour is carried through as `Detection.polygon`, which gives the
    severity engine a far better visible-area estimate than a bounding box.
    """

    def __init__(
        self,
        model_path: Path,
        config: VisionConfig,
        model_version: str | None = None,
        device: str | None = None,
    ) -> None:
        # Imported lazily: torch is a heavy optional dependency, and the CLI must start
        # without it when running the synthetic detector or an ONNX model.
        from ultralytics import YOLO

        self._config = config
        self._device = device
        self._model = YOLO(str(model_path))
        self._names: dict[int, str] = dict(self._model.names or {})

        # Match the pothole class by NAME, never by index: a third-party checkpoint's
        # class order is unknown, and index 0 may be something else entirely. A model
        # trained on RDD2022, for instance, puts longitudinal cracks at index 0 and
        # potholes at index 3 - matching by position would report cracks as potholes.
        self._pothole_class_ids = {
            class_id for class_id, name in self._names.items() if is_pothole_class(str(name))
        }
        if not self._pothole_class_ids:
            raise ValueError(
                f"{model_path} exposes no pothole class (found: {sorted(self._names.values())}; "
                f"recognised names: {', '.join(sorted(POTHOLE_CLASS_ALIASES))}). "
                "The MVP has no other detection class."
            )

        self._other_classes: dict[str, int] = {}
        self._info = DetectorInfo(
            kind="ultralytics",
            model_version=model_version or model_path.stem,
            backend=f"{self._model.task}/{device or 'auto'}",
            is_synthetic=False,
            selection_reason=f"Ultralytics checkpoint loaded from {model_path}",
        )

    @property
    def info(self) -> DetectorInfo:
        return self._info

    @property
    def class_names(self) -> dict[int, str]:
        return dict(self._names)

    @property
    def other_class_counts(self) -> dict[str, int]:
        return dict(self._other_classes)

    def detect(self, frame: np.ndarray) -> list[Detection]:
        predict_kwargs: dict[str, object] = {
            "conf": self._config.detection.confidence_threshold,
            "iou": self._config.detection.nms_iou_threshold,
            "imgsz": self._config.model.input_size,
            "max_det": self._config.detection.max_detections,
            "verbose": False,
        }
        if self._device:
            predict_kwargs["device"] = self._device

        result = self._model.predict(frame, **predict_kwargs)[0]
        boxes = result.boxes
        if boxes is None or len(boxes) == 0:
            return []

        # Ultralytics gives normalised corner-form boxes directly, which is exactly the
        # convention this system uses everywhere.
        xyxyn = boxes.xyxyn.cpu().numpy()
        confidences = boxes.conf.cpu().numpy()
        class_ids = boxes.cls.cpu().numpy().astype(int)

        polygons = None
        masks = getattr(result, "masks", None)
        if masks is not None and masks.xyn is not None:
            polygons = masks.xyn

        detections: list[Detection] = []
        for index, class_id in enumerate(class_ids):
            if class_id not in self._pothole_class_ids:
                name = self._names.get(int(class_id))
                if name is not None:
                    self._other_classes[str(name)] = self._other_classes.get(str(name), 0) + 1
                continue

            x1, y1, x2, y2 = (float(v) for v in xyxyn[index])
            bbox = BoundingBox(x1, y1, x2 - x1, y2 - y1).clamped()
            if bbox.area <= 0:
                continue

            polygon: list[tuple[float, float]] | None = None
            if polygons is not None and index < len(polygons):
                contour = polygons[index]
                if contour is not None and len(contour) >= 3:
                    polygon = [(float(px), float(py)) for px, py in contour]

            detections.append(
                Detection(
                    class_id=int(class_id),
                    class_name="pothole",
                    confidence=float(confidences[index]),
                    bbox=bbox,
                    polygon=polygon,
                )
            )

        return detections

    def close(self) -> None:
        self._model = None  # type: ignore[assignment]


@dataclass(slots=True)
class _VirtualPothole:
    distance_m: float
    speed_mps: float
    width_m: float
    offset_m: float
    aspect: float
    peak_confidence: float


class MockDetector:
    """Deterministic synthetic detector.

    Keeps the pipeline and the CLI usable while no trained weights exist. It does not
    look at the pixels it is given and it is NOT a detector: every output path must
    surface ``info.is_synthetic`` so its output can never be mistaken for a model's.

    The simulation projects potholes on a road plane through a simple pinhole model, so
    they move and grow the way real ones do from a windshield-mounted phone. Output
    depends only on the seed and the number of frames processed.
    """

    def __init__(
        self, config: VisionConfig, seed: int | None = None, selection_reason: str | None = None
    ) -> None:
        self._config = config
        self._rand = create_prng(seed if seed is not None else config.mock.seed)
        self._frame_index = -1
        self._next_spawn_frame = 0
        self._active: list[_VirtualPothole] = []
        self._info = DetectorInfo(
            kind="mock",
            model_version=MOCK_MODEL_VERSION,
            backend="synthetic",
            is_synthetic=True,
            selection_reason=selection_reason or "No model supplied; using the synthetic detector.",
        )

    @property
    def info(self) -> DetectorInfo:
        return self._info

    @property
    def other_class_counts(self) -> dict[str, int]:
        """Single-class by construction, so there is never anything else to report."""
        return {}

    def detect(self, frame: np.ndarray) -> list[Detection]:  # noqa: ARG002 - pixels are ignored by design
        mock = self._config.mock
        self._frame_index += 1

        if self._frame_index >= self._next_spawn_frame:
            self._active.append(self._spawn())
            gap = random_between(self._rand, mock.min_gap_seconds, mock.max_gap_seconds)
            self._next_spawn_frame = self._frame_index + max(1, round(gap * mock.virtual_fps))

        detections: list[Detection] = []
        survivors: list[_VirtualPothole] = []

        for pothole in self._active:
            if pothole.distance_m <= mock.exit_distance_m:
                continue
            survivors.append(pothole)

            bbox, confidence = self._project(pothole)
            pothole.distance_m -= pothole.speed_mps / mock.virtual_fps

            # A frame the simulated detector misses, so the tracker has to bridge it.
            if self._rand() < mock.dropout_probability:
                continue
            if confidence < 0.05:
                continue

            detections.append(Detection(0, "pothole", confidence, bbox.clamped()))

        self._active = survivors

        if self._rand() < mock.false_positive_probability:
            # A one-frame low-confidence blob: a shadow or a wet patch. The confirmation
            # rules must throw it away.
            width = random_between(self._rand, 0.03, 0.07)
            detections.append(
                Detection(
                    0,
                    "pothole",
                    random_between(self._rand, 0.36, 0.52),
                    BoundingBox(
                        random_between(self._rand, 0.05, 0.9),
                        random_between(self._rand, 0.45, 0.85),
                        width,
                        width * 0.6,
                    ).clamped(),
                )
            )

        return detections

    def close(self) -> None:
        self._active = []

    def _project(self, pothole: _VirtualPothole) -> tuple[BoundingBox, float]:
        mock = self._config.mock
        distance = pothole.distance_m

        centre_y = mock.horizon_y + mock.perspective_k / distance
        width = pothole.width_m / (mock.lateral_spread_k * distance)
        height = width * pothole.aspect
        centre_x = 0.5 + pothole.offset_m / (mock.lateral_spread_k * distance)

        visibility = min(1.0, width / mock.confidence_width_reference)
        noise = (self._rand() - 0.5) * 0.05
        confidence = min(0.99, max(0.0, pothole.peak_confidence * (0.3 + 0.7 * visibility) + noise))

        return BoundingBox(centre_x - width / 2, centre_y - height / 2, width, height), confidence

    def _spawn(self) -> _VirtualPothole:
        mock = self._config.mock
        return _VirtualPothole(
            distance_m=mock.spawn_distance_m,
            speed_mps=random_between(self._rand, mock.speed_mps_min, mock.speed_mps_max),
            width_m=random_between(self._rand, mock.pothole_width_min_m, mock.pothole_width_max_m),
            offset_m=random_between(self._rand, -1.4, 1.4),
            aspect=random_between(self._rand, 0.45, 0.7),
            peak_confidence=random_between(self._rand, 0.74, 0.97),
        )


def read_sidecar_manifest(model_path: Path) -> dict[str, object]:
    """Read `model.json` sitting next to an ONNX file, if it describes that file.

    The export tool writes this manifest from the shapes it observed, and the browser
    reads the same file. Reading it here means the CLI and the browser cannot end up
    decoding one model two different ways.
    """
    manifest_path = model_path.parent / "model.json"
    if not manifest_path.exists():
        return {}
    try:
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(raw, dict):
        return {}
    if raw.get("file") not in (None, model_path.name):
        return {}
    return raw


def checkpoint_version(model_path: Path) -> str | None:
    """`name-version` for a `.pt` checkpoint, from the `model.json` beside it.

    A checkpoint carries no semantic version of its own, and falling back to the file
    stem recorded `pothole-detector` while the browser, running the same weights exported
    to ONNX, recorded `pothole-road-anomaly-1.0.0`. Events from the two paths could not be
    compared by `model_version`. The manifest names the checkpoint it describes, so a
    stale manifest for some other file is ignored rather than mislabelling this one.
    """
    manifest_path = model_path.parent / "model.json"
    try:
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(raw, dict) or raw.get("checkpoint") != model_path.name:
        return None
    if raw.get("name") and raw.get("version"):
        return f"{raw['name']}-{raw['version']}"
    return None


def create_detector(
    config: VisionConfig,
    model_path: Path | None,
    model_version: str | None = None,
    layout: OutputLayout = "auto",
    device: str | None = None,
) -> Detector:
    """Select a detector.

    Dispatch is by file extension: `.pt` loads an Ultralytics checkpoint, `.onnx` runs
    onnxruntime. Without a model the synthetic detector is used and the choice is
    announced on stderr, because fabricated output must never be mistaken for a model
    reading.
    """
    if model_path is not None:
        if not model_path.exists():
            raise FileNotFoundError(f"Model not found: {model_path}")

        suffix = model_path.suffix.lower()
        if suffix == ".pt":
            return UltralyticsDetector(
                model_path,
                config,
                model_version=model_version or checkpoint_version(model_path),
                device=device,
            )
        if suffix == ".onnx":
            manifest = read_sidecar_manifest(model_path)
            resolved_layout = layout
            if layout == "auto" and isinstance(manifest.get("outputLayout"), str):
                resolved_layout = manifest["outputLayout"]  # type: ignore[assignment]
            mask_coefficients = manifest.get("maskCoefficients") or 0
            manifest_classes = manifest.get("classNames")
            class_names = (
                tuple(str(n) for n in manifest_classes)
                if isinstance(manifest_classes, list) and manifest_classes
                else None
            )
            version = model_version
            if version is None and manifest.get("name") and manifest.get("version"):
                version = f"{manifest['name']}-{manifest['version']}"
            return OnnxDetector(
                model_path,
                config,
                model_version=version,
                layout=resolved_layout,
                mask_coefficients=int(mask_coefficients),
                class_names=class_names,
            )
        raise ValueError(f"Unsupported model format '{suffix}'. Use .pt (Ultralytics) or .onnx.")

    print(
        "WARNING: no --model supplied. Detections are SYNTHETIC output from MockDetector,\n"
        "         produced to exercise the pipeline. They are not a reading of this video.",
        file=sys.stderr,
    )
    return MockDetector(
        config,
        selection_reason="No model supplied; detections are synthetic, not model output.",
    )
