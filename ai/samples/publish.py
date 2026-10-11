"""Publish an analysis through the site's API, as a browser does: record, uploads, completion."""

from __future__ import annotations

import json
from pathlib import Path

import requests

from ai.samples.catalog import MODEL_VERSION, Sample
from ai.samples.ids import analysis_id


class PublishError(RuntimeError):
    """Publishing would file an analysis where the dashboard never looks, or mix two runs."""


def _upload(target: dict, data: bytes, content_type: str) -> bool:
    response = requests.post(
        target["url"],
        data=target["fields"],
        files={"file": ("upload", data, content_type)},
        timeout=120,
    )
    return response.ok


def _check_same_run(sample: Sample, aid: str, stored: list[dict], analysis: dict) -> None:
    """The API keeps an id's first potholes, so uploads from another run would mix the two."""
    old = sorted(p["trackId"] for p in stored)  # the API answers in clip order
    new = sorted(p["trackId"] for p in analysis["potholes"])
    if old != new:
        raise PublishError(
            f"{sample.id}: {aid} is already published from another run (stored {len(old)} "
            f"potholes, this analysis {len(new)}; only stored: "
            f"{', '.join(sorted(set(old) - set(new))) or 'none'}; only here: "
            f"{', '.join(sorted(set(new) - set(old))) or 'none'}). The API never replaces "
            "stored potholes, so publishing would attach this run's photos to them."
        )


def publish(
    api: str, sample: Sample, analysis: dict, crops_dir: Path, threshold: float, fps: float
) -> str:
    """Returns the analysis id; publishing the same analysis again changes nothing."""
    if analysis["modelVersion"] != MODEL_VERSION:
        raise PublishError(
            f"{sample.id}: analysed with {analysis['modelVersion']!r}, but the dashboard "
            f"requests {MODEL_VERSION!r} (SAMPLE_SETUP in apps/web/features/videos/lib/"
            "samples.ts), so it would never find this analysis's id"
        )
    aid = analysis_id(f"demo:{sample.id}", MODEL_VERSION, threshold, fps)
    crops = {p["trackId"]: crops_dir / f"{p['trackId']}.jpg" for p in analysis["potholes"]}
    body = {
        "id": aid,
        "title": sample.title,
        "fileName": f"{sample.id.upper()}.MP4",
        "source": "demo",
        "videoUrl": f"/demo/{sample.id}.mp4",
        "posterUrl": f"/demo/{sample.id}.jpg",
        "videoContentType": None,
        "recordedAt": sample.recorded_at,
        "confidenceThreshold": threshold,
        "sampleFps": fps,
        **{
            k: analysis[k]
            for k in (
                "durationSeconds",
                "width",
                "height",
                "modelVersion",
                "framesAnalysed",
                "rawDetections",
                "rejectedTracks",
                "averageInferenceMs",
            )
        },
        "potholes": [
            {**p, "hasCrop": crops[p["trackId"]].exists(), "hasFull": False}
            for p in analysis["potholes"]
        ],
    }
    created = requests.post(f"{api}/api/v1/video-analyses", json=body, timeout=60)
    created.raise_for_status()
    answer = created.json()
    if created.status_code == 200:  # already saved: only the same run may finish its uploads
        _check_same_run(sample, aid, answer["analysis"]["potholes"], analysis)
    uploads = answer["uploads"]

    done: dict = {"overlay": False, "poster": False, "video": False, "crops": [], "fulls": []}
    if uploads.get("overlay"):
        done["overlay"] = _upload(
            uploads["overlay"], json.dumps(analysis["frames"]).encode(), "application/json"
        )
    for track_id, targets in (uploads.get("potholes") or {}).items():
        crop = crops.get(track_id)
        if (
            targets.get("crop")
            and crop
            and crop.exists()
            and _upload(targets["crop"], crop.read_bytes(), "image/jpeg")
        ):
            done["crops"].append(track_id)
    requests.post(
        f"{api}/api/v1/video-analyses/{aid}/complete", json=done, timeout=60
    ).raise_for_status()
    if sample.location:
        requests.put(
            f"{api}/api/v1/video-analyses/{aid}/location", json=sample.location, timeout=60
        ).raise_for_status()
    return aid
