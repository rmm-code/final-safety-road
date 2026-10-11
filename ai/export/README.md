# Export

Not yet implemented. PyTorch to ONNX export belongs here.

Export at the input size the model manifest declares, with static shapes, and verify the
exported graph against the original predictions before deploying. Post-processing expects
the Ultralytics YOLOv8/v11 detection head; see [`docs/ai.md`](../../docs/ai.md) and
[`apps/web/public/models/README.md`](../../apps/web/public/models/README.md).
