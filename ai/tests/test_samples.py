"""Pre-analysed sample videos (`ai/samples`)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from ai.inference.config import VisionConfig
from ai.inference.detector import MockDetector
from ai.samples.__main__ import main, reset_sample_output
from ai.samples.analyse import analyse
from ai.samples.catalog import MODEL_VERSION, SAMPLE_FPS, SAMPLES, THRESHOLD
from ai.samples.ids import analysis_id
from ai.samples.publish import PublishError, publish

MERGED = "pothole-road-anomaly-1.0.0+mfranzon-yolo26m-1.0.0+rezzzq-yolo12s-1.0.0"
VIDEO_2 = next(sample for sample in SAMPLES if sample.id == "video-2")
VIDEO_2_ID = "4d22bf79-4764-8ade-8328-d4d1bcddb0ac"
# A reserved TLD: even a call the fakes missed could never reach a real site.
API = "https://api.invalid"
CREATE = f"{API}/api/v1/video-analyses"


def test_the_id_matches_the_one_the_web_app_derives() -> None:
    # Computed by features/videos/lib/analysis-id.ts for the same inputs.
    assert analysis_id("demo:video-2", MERGED, 0.35, 12) == "b74149fd-b3bb-88ac-a229-1e7a89f40dec"
    assert analysis_id("demo:video-2", MERGED, 0.35, 12.0) == analysis_id(
        "demo:video-2", MERGED, 0.35, 12
    )


def test_exports_the_browser_analysis_format(
    synthetic_video: Path, config: VisionConfig, tmp_path: Path
) -> None:
    analysis = analyse(
        synthetic_video, MockDetector(config, selection_reason="test"), config, tmp_path
    )

    assert analysis["framesAnalysed"] == len(analysis["frames"]) > 0
    assert analysis["modelVersion"].startswith("mock-")
    frame = next(f for f in analysis["frames"] if f["detections"])
    detection = frame["detections"][0]
    assert set(detection) == {"detection", "trackId"}
    assert set(detection["detection"]["bbox"]) == {"x", "y", "width", "height"}
    for pothole in analysis["potholes"]:
        assert {"trackId", "firstSeenSeconds", "severity", "confidence", "maxArea"} <= set(pothole)
        assert (tmp_path / f"{pothole['trackId']}.jpg").exists()


def _analysis(*track_ids: str, model_version: str = MODEL_VERSION) -> dict:
    """Every field publish sends, for potholes with these track ids."""
    return {
        "modelVersion": model_version,
        "durationSeconds": 30.0,
        "width": 1280,
        "height": 720,
        "framesAnalysed": 360,
        "rawDetections": 12,
        "rejectedTracks": 1,
        "averageInferenceMs": 80.0,
        "potholes": [{"trackId": t, "firstSeenSeconds": float(i)} for i, t in enumerate(track_ids)],
        "frames": [],
    }


def _crops(folder: Path, *track_ids: str) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    for track_id in track_ids:
        (folder / f"{track_id}.jpg").write_bytes(b"jpeg")
    return folder


class _Response:
    def __init__(self, status_code: int, body: dict | None = None) -> None:
        self.status_code = status_code
        self.ok = status_code < 400
        self._body = body or {}

    def json(self) -> dict:
        return self._body

    def raise_for_status(self) -> None:
        if not self.ok:
            raise AssertionError(f"HTTP {self.status_code}")


class _FakeApi:
    """Stands in for `requests` inside ai.samples.publish: records every call, no network."""

    def __init__(self, status_code: int, stored: list[str], crop_uploads: list[str]) -> None:
        self.calls: list[tuple[str, str]] = []
        self.completed: dict = {}
        self._created = _Response(
            status_code,
            {
                "analysis": {"potholes": [{"trackId": t} for t in stored]},
                "uploads": {
                    "potholes": {
                        t: {"crop": {"url": f"https://storage.invalid/{t}", "fields": {}}}
                        for t in crop_uploads
                    }
                },
            },
        )

    def post(self, url: str, **kwargs: Any) -> _Response:
        self.calls.append(("POST", url))
        if url == CREATE:
            return self._created
        if url.endswith("/complete"):
            self.completed = kwargs["json"]
        return _Response(204)

    def put(self, url: str, **kwargs: Any) -> _Response:
        self.calls.append(("PUT", url))
        return _Response(200)


def test_the_catalog_pins_the_setup_the_dashboard_requests() -> None:
    assert analysis_id("demo:video-2", MODEL_VERSION, THRESHOLD, SAMPLE_FPS) == VIDEO_2_ID


def test_refuses_an_analysis_from_a_model_the_dashboard_does_not_request(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    api = _FakeApi(201, stored=["track-001"], crop_uploads=["track-001"])
    monkeypatch.setattr("ai.samples.publish.requests", api)
    bumped = MODEL_VERSION.replace("0.1.0", "0.2.0")

    with pytest.raises(PublishError, match="dashboard requests"):
        publish(
            API,
            VIDEO_2,
            _analysis("track-001", model_version=bumped),
            _crops(tmp_path, "track-001"),
            THRESHOLD,
            SAMPLE_FPS,
        )

    assert api.calls == []


@pytest.mark.parametrize(
    "stored",
    [
        pytest.param(["track-001", "track-004", "track-009"], id="more-potholes-stored"),
        pytest.param(["track-001", "track-009"], id="same-count-other-tracks"),
    ],
)
def test_refuses_to_mix_two_runs_under_one_id(
    stored: list[str], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # 200: the id was published before, by a run that found other potholes.
    api = _FakeApi(200, stored=stored, crop_uploads=stored)
    monkeypatch.setattr("ai.samples.publish.requests", api)

    with pytest.raises(PublishError, match="already published"):
        publish(
            API,
            VIDEO_2,
            _analysis("track-001", "track-004"),
            _crops(tmp_path, "track-001", "track-004"),
            THRESHOLD,
            SAMPLE_FPS,
        )

    # Nothing from this run reached the stored record: no upload, completion or location.
    assert api.calls == [("POST", CREATE)]


def test_republishing_the_identical_analysis_only_finishes_missing_uploads(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # 200 for the same run: potholes come back in clip order, one crop still missing.
    api = _FakeApi(200, stored=["track-004", "track-001"], crop_uploads=["track-004"])
    monkeypatch.setattr("ai.samples.publish.requests", api)

    aid = publish(
        API,
        VIDEO_2,
        _analysis("track-001", "track-004"),
        _crops(tmp_path, "track-001", "track-004"),
        THRESHOLD,
        SAMPLE_FPS,
    )

    assert aid == VIDEO_2_ID
    assert api.calls == [
        ("POST", CREATE),
        ("POST", "https://storage.invalid/track-004"),
        ("POST", f"{CREATE}/{aid}/complete"),
        ("PUT", f"{CREATE}/{aid}/location"),
    ]
    assert api.completed["crops"] == ["track-004"]


def test_reset_sample_output_removes_the_previous_runs_crops_and_analysis(
    tmp_path: Path,
) -> None:
    folder = tmp_path / "video-1"
    _crops(folder / "crops", "track-002")
    (folder / "analysis.json").write_text("{}")
    (folder / "notes.txt").write_text("not the tool's")

    reset_sample_output(folder)

    assert not any((folder / "crops").glob("*"))
    assert not (folder / "analysis.json").exists()
    assert (folder / "notes.txt").exists()
    reset_sample_output(tmp_path / "video-9")  # never analysed: nothing to remove


class _NoDetector:
    def __init__(self, *args: object) -> None:
        pass

    def close(self) -> None:
        pass


def _run_main(
    monkeypatch: pytest.MonkeyPatch,
    out: Path,
    *flags: str,
    analysis: dict | None = None,
    new_crops: tuple[str, ...] = (),
) -> list[tuple[dict, list[str]]]:
    """main() on video-1 with detectors, analysis and API stubbed; returns what it published.

    With analysis=None, analysing at all fails the test.
    """
    published: list[tuple[dict, list[str]]] = []

    def fake_analyse(video: Path, detector: object, config: object, crops_dir: Path) -> dict:
        assert analysis is not None, "re-analysed instead of reusing the saved analysis"
        _crops(crops_dir, *new_crops)
        return analysis

    def fake_publish(api: str, sample: object, saved: dict, crops_dir: Path, *setup: float) -> str:
        published.append((saved, sorted(p.name for p in crops_dir.glob("*.jpg"))))
        return "published-id"

    stubs = {
        "create_detector": _NoDetector,
        "MergedDetector": _NoDetector,
        "analyse": fake_analyse,
        "publish": fake_publish,
    }
    for name, stub in stubs.items():
        monkeypatch.setattr(f"ai.samples.__main__.{name}", stub)
    # Always --out: the default, output/samples, holds the published analyses.
    assert main(["--api", API, "--only", "video-1", "--out", str(out), *flags]) == 0
    return published


def test_a_fresh_run_never_publishes_a_crop_left_by_an_earlier_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The earlier run cropped track-001 and track-002; this run crops only track-001.
    _crops(tmp_path / "video-1" / "crops", "track-001", "track-002")
    fresh = _analysis("track-001", "track-002")

    published = _run_main(monkeypatch, tmp_path, analysis=fresh, new_crops=("track-001",))

    assert published == [(fresh, ["track-001.jpg"])]


def test_reuse_publishes_the_saved_analysis_and_crops_untouched(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    folder = tmp_path / "video-1"
    saved = _analysis("track-001", "track-002")
    (folder / "crops").mkdir(parents=True)
    (folder / "crops" / "track-001.jpg").write_bytes(b"saved photo")
    (folder / "analysis.json").write_text(json.dumps(saved))

    published = _run_main(monkeypatch, tmp_path, "--reuse")

    assert published == [(saved, ["track-001.jpg"])]
    assert (folder / "crops" / "track-001.jpg").read_bytes() == b"saved photo"
    assert json.loads((folder / "analysis.json").read_text()) == saved


def test_samples_lower_the_confirmation_gate_without_touching_the_live_config() -> None:
    from ai.inference.config import load_vision_config
    from ai.samples.__main__ import sample_config
    from ai.samples.catalog import CONFIRM_MIN_CONFIDENCE

    config = sample_config()

    assert config.tracking.min_max_confidence == CONFIRM_MIN_CONFIDENCE
    assert config.detection.confidence_threshold == THRESHOLD
    assert config.sample_fps == SAMPLE_FPS
    # The live drive reads vision.yaml, which keeps the gate it was measured with.
    assert load_vision_config().tracking.min_max_confidence == 0.55
