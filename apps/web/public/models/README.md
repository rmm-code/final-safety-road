# Model deployment

The browser detector loads whatever is described by `model.json` in this directory.
Nothing here is committed: weights are versioned build artifacts, not source
(see `.gitignore`).

## Installing a model

1. Train and export a detector — see [`docs/ai.md`](../../../../docs/ai.md).
2. Copy the exported weights here, named with their version:

   ```text
   apps/web/public/models/pothole-detector-0.1.0.onnx
   ```

3. Write the manifest next to it:

   ```json
   {
     "name": "pothole-detector",
     "version": "0.1.0",
     "file": "pothole-detector-0.1.0.onnx",
     "inputSize": 640,
     "classNames": ["pothole"]
   }
   ```

4. Copy the ONNX Runtime WebAssembly binaries once per checkout:

   ```bash
   npm run sync:ort-runtime --workspace @pothole/web
   ```

5. Reload `/analyze`. The engine badge switches from **Synthetic engine** to
   **ONNX Runtime Web**, and the synthetic-output warning disappears.

## Manifest fields

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Model family. Combined with `version` to form the recorded `model_version`. |
| `version` | yes | Semantic version. A deployed version is never overwritten; publish a new one. |
| `file` | yes | Weights filename, relative to this directory, or an absolute URL. |
| `inputSize` | yes | Square network input edge in pixels, e.g. `640`. |
| `classNames` | yes | Class names in model output order. Must include `pothole`. |
| `outputLayout` | no | `auto` (default), `channels-first` or `channels-last`. |
| `confidenceThreshold` | no | Overrides the pipeline default for this model. |
| `nmsIouThreshold` | no | Overrides the pipeline default for this model. |

## Input size and orientation

Export **square** unless you know the footage orientation.

Ultralytics runs `.pt` inference rectangularly, matching the source aspect. An ONNX
export has a fixed input, so a mismatch letterboxes most of the frame away. Measured on
portrait dashcam footage with the same weights:

| Export | Detections |
| --- | --- |
| Portrait `384x640` | 21 (matches the `.pt` exactly) |
| **Square `640x640`** | **19** |
| Landscape `640x384` | 10 |

Square costs about a tenth of the detections and works for any orientation. A landscape
export loses half on portrait video, which is the failure worth avoiding.

`--quantize 16` halves the file with no measurable accuracy cost - identical detections
and confidences in testing. That matters when a driver downloads the model over mobile
data before setting off.

## Assumed output format

Post-processing expects the Ultralytics YOLOv8/v11 detection head: a
`[1, 4 + numClasses, numAnchors]` tensor of centre-form boxes in input pixels with
sigmoid-activated class scores and no separate objectness channel. A transposed head is
detected automatically, or can be declared with `outputLayout`. A model with a different
head needs a decoder in `packages/vision-web/src/postprocess/decode.ts`; it must not be
worked around in product code.

## Without a model

With no manifest present the app runs `MockVisionEngine`, which fabricates detections
from a simple road-geometry simulation so the pipeline and UI stay usable. Its output is
labelled synthetic in the interface and in every exported report, and its
`modelVersion` is prefixed `mock-`.
