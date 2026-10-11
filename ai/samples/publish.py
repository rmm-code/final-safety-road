"""Publish an analysis through the site's API, as a browser does: record, uploads, completion."""

from __future__ import annotations

import json
from pathlib import Path

import requests

from ai.samples.catalog import Sample
from ai.samples.ids import analysis_id


def _upload(target: dict, data: bytes, content_type: str) -> bool:
    response = requests.post(
        target["url"],
        data=target["fields"],
        files={"file": ("upload", data, content_type)},
        timeout=120,
    )
    return response.ok


def publish(
    api: str, sample: Sample, analysis: dict, crops_dir: Path, threshold: float, fps: float
) -> str:
    """Returns the analysis id; publishing the same analysis again changes nothing."""
    aid = analysis_id(f"demo:{sample.id}", analysis["modelVersion"], threshold, fps)
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
    uploads = created.json()["uploads"]

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
