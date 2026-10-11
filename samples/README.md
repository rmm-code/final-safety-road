# Test footage

Local driving videos for evaluating a model. Not committed — footage is large, and may be
personally identifying.

```text
samples/tashkent-drive.mp4
```

The most valuable footage is your own: a windshield-mounted phone recording a local road
matches the camera geometry, mounting height and road surface the system will actually
run on. Stock clips are mostly smooth highways or fixed roadside cameras, neither of which
resembles the sensor.

Pair a clip with a ground-truth file so the run can be scored — see
[`ai/evaluation/README.md`](../ai/evaluation/README.md).
