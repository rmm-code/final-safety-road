# Server-side models

Weights for the Python pipeline. Nothing here is committed — models are versioned build
artifacts, not source.

```text
models/pothole-detector.pt      # Ultralytics checkpoint, used by the Python CLI
```

Usage:

```bash
.venv/bin/python -m ai.inference.video \
  --model ./models/pothole-detector.pt \
  --input ./samples/tashkent-drive.mp4 \
  --output ./output/annotated.mp4
```

The browser loads a different artifact — an ONNX export in
`apps/web/public/models/`. See [`docs/ai.md`](../docs/ai.md) for the export step and
[`apps/web/public/models/README.md`](../apps/web/public/models/README.md) for the manifest
format.

Every model carries a semantic version, recorded on every detection. A checkpoint takes
it from `models/model.json`, which names the file it describes:

```json
{ "name": "pothole-road-anomaly", "version": "1.0.0", "checkpoint": "pothole-detector.pt" }
```

so the CLI records `pothole-road-anomaly-1.0.0`, the same version the browser records
for the ONNX export of the same weights. `--model-version` overrides it.

Deployed versions are never overwritten; publish a new one.
