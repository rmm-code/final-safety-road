"""Export an Ultralytics checkpoint to ONNX and write the browser model manifest.

    python -m ai.export.to_onnx \\
      --model ./models/pothole-detector.pt \\
      --version 0.1.0 \\
      --out apps/web/public/models

The manifest is written from the SHAPES OBSERVED in the exported graph, never assumed.
Ultralytics changes its default export format between versions - YOLO26 exports an
end-to-end `(1, max_det, 6)` head by default, YOLOv8/v11 export the raw
`(1, 4 + nc, anchors)` head, and segmentation models add mask coefficients - so guessing
would silently mis-decode every box.

`nms=True` is deliberately NOT used: the browser pipeline runs its own NMS so that the
threshold stays configurable at runtime rather than being baked into the graph.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path
from typing import Any


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python -m ai.export.to_onnx",
        description="Export a pothole checkpoint to ONNX for browser inference.",
    )
    parser.add_argument("--model", required=True, type=Path, help="Ultralytics .pt checkpoint")
    parser.add_argument("--version", required=True, help="Semantic version, e.g. 0.1.0")
    parser.add_argument("--name", default="pothole-detector", help="Model family name")
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("apps/web/public/models"),
        help="Directory to write the .onnx file and model.json into",
    )
    parser.add_argument(
        "--imgsz",
        default="640",
        help=(
            "Input size: a single number for square, or HEIGHT,WIDTH for rectangular. "
            "Ultralytics runs .pt inference rectangularly (e.g. 384,640 for 16:9), so a "
            "square export sees the road at a different scale and detects noticeably less."
        ),
    )
    parser.add_argument("--opset", type=int, help="ONNX opset version")
    parser.add_argument(
        "--quantize",
        choices=["16", "32"],
        help=(
            "Weight precision. 16 roughly halves the file, which matters a great deal "
            "when a driver downloads it over mobile data before a drive."
        ),
    )
    parser.add_argument(
        "--simplify",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Simplify the exported graph (default: on)",
    )
    return parser.parse_args(argv)


def _parse_imgsz(raw: str) -> int | tuple[int, int]:
    """Accept "640" (square) or "384,640" (height, width)."""
    parts = [int(p.strip()) for p in str(raw).split(",") if p.strip()]
    if len(parts) == 1:
        return parts[0]
    if len(parts) == 2:
        return (parts[0], parts[1])
    raise ValueError(f"--imgsz must be N or HEIGHT,WIDTH; got {raw!r}")


def describe_onnx(path: Path) -> dict[str, Any]:
    """Read the real input/output names and shapes out of the exported graph."""
    import onnxruntime as ort

    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    return {
        "inputs": [{"name": i.name, "shape": i.shape} for i in session.get_inputs()],
        "outputs": [{"name": o.name, "shape": o.shape} for o in session.get_outputs()],
    }


def infer_manifest_layout(outputs: list[dict[str, Any]], num_classes: int) -> tuple[str, str, int]:
    """Derive (task, layout, maskCoefficients) from the observed output shapes."""
    primary = outputs[0]["shape"]
    if len(primary) != 3:
        raise ValueError(f"Unsupported primary output shape {primary}; expected 3 dimensions")

    axis1, axis2 = primary[1], primary[2]
    detect_channels = 4 + num_classes

    # A second output of rank 4 is the mask prototype tensor of a segmentation head.
    is_segmentation = len(outputs) > 1 and len(outputs[1]["shape"]) == 4
    mask_coefficients = 0
    if is_segmentation:
        mask_coefficients = int(outputs[1]["shape"][1])

    if axis1 == detect_channels + mask_coefficients:
        layout = "channels-first"
    elif axis2 == detect_channels + mask_coefficients:
        layout = "channels-last"
    elif axis2 == 6:
        # End-to-end head: [x1, y1, x2, y2, confidence, class]. No NMS needed.
        return "detect", "end-to-end", 0
    else:
        raise ValueError(
            f"Cannot interpret output shape {primary} for {num_classes} class(es). "
            "Declare the layout by hand in model.json."
        )

    return ("segment" if is_segmentation else "detect"), layout, mask_coefficients


def run(argv: list[str] | None = None) -> Path:
    args = parse_args(argv)
    if not args.model.exists():
        raise FileNotFoundError(f"Checkpoint not found: {args.model}")

    from ultralytics import YOLO

    model = YOLO(str(args.model))
    class_names = [str(name) for _, name in sorted((model.names or {}).items())]
    from ai.inference.detector import POTHOLE_CLASS_ALIASES

    if not any(name.strip().lower() in POTHOLE_CLASS_ALIASES for name in class_names):
        raise ValueError(
            f"{args.model} exposes no pothole class (found {class_names}; recognised: "
            f"{', '.join(sorted(POTHOLE_CLASS_ALIASES))})."
        )

    imgsz = _parse_imgsz(args.imgsz)

    export_kwargs: dict[str, Any] = {
        "format": "onnx",
        "imgsz": imgsz,
        "simplify": args.simplify,
        "dynamic": False,
        "nms": False,
    }
    if args.opset is not None:
        export_kwargs["opset"] = args.opset
    if args.quantize is not None:
        export_kwargs["quantize"] = int(args.quantize)

    print(f"Exporting {args.model} -> ONNX (imgsz={imgsz})", file=sys.stderr)
    exported = Path(model.export(**export_kwargs))

    args.out.mkdir(parents=True, exist_ok=True)
    weights_name = f"{args.name}-{args.version}.onnx"
    weights_path = args.out / weights_name
    shutil.move(str(exported), weights_path)

    graph = describe_onnx(weights_path)
    task, layout, mask_coefficients = infer_manifest_layout(graph["outputs"], len(class_names))

    # Input size comes from the exported graph, not from the request: the exporter may
    # round to a stride multiple, and decoding against the wrong size shifts every box.
    input_shape = graph["inputs"][0]["shape"]
    input_height, input_width = int(input_shape[2]), int(input_shape[3])

    manifest: dict[str, Any] = {
        "name": args.name,
        "version": args.version,
        "file": weights_name,
        "inputSize": max(input_width, input_height),
        "inputWidth": input_width,
        "inputHeight": input_height,
        "classNames": class_names,
        "task": task,
        "outputLayout": layout,
    }
    if mask_coefficients:
        manifest["maskCoefficients"] = mask_coefficients

    manifest_path = args.out / "model.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    print(f"\nWeights   {weights_path} ({weights_path.stat().st_size / 1e6:.1f} MB)")
    print(f"Manifest  {manifest_path}")
    print(f"Inputs    {graph['inputs']}  ({input_width}x{input_height})")
    print(f"Outputs   {graph['outputs']}")
    print(f"Detected  task={task} layout={layout} maskCoefficients={mask_coefficients}")
    print("\nNext: npm run sync:ort-runtime --workspace @pothole/web, then reload /analyze")

    return manifest_path


def main(argv: list[str] | None = None) -> int:
    try:
        run(argv)
    except (FileNotFoundError, ValueError, RuntimeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
