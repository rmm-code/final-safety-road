"use client";

/**
 * Live confidence threshold control.
 *
 * The default comes from `ai/configs/vision.yaml` and nothing here hard-codes a value -
 * this only lets an operator move off the configured default while they are looking at
 * results. That matters because the right threshold is a property of the road and the
 * model, not of the code: the same 0.35 that works on dry asphalt buries real potholes in
 * winter slush, and finding out means trying it against footage.
 */
export function ThresholdControl({
  value,
  defaultValue,
  min = 0.05,
  max = 0.95,
  step = 0.05,
  disabled = false,
  label = "Confidence threshold",
  hint,
  onChange,
  onReset,
}: {
  value: number;
  defaultValue: number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  label?: string;
  hint?: string;
  onChange: (value: number) => void;
  onReset: () => void;
}) {
  const modified = Math.abs(value - defaultValue) > 1e-9;

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <label htmlFor="confidence-threshold" className="text-[13px] text-secondary">
          {label}
        </label>
        <span className="flex items-center gap-2">
          <span className="tabular font-mono text-[13px] text-primary">{value.toFixed(2)}</span>
          {modified && (
            <button
              type="button"
              onClick={onReset}
              className="text-[11px] text-blue-strong hover:underline"
            >
              reset
            </button>
          )}
        </span>
      </div>

      <input
        id="confidence-threshold"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label={label}
        aria-valuetext={value.toFixed(2)}
        className="mt-1.5 w-full accent-[#2563EB] disabled:opacity-45"
      />

      <p className="mt-1 text-[11px] leading-4 text-muted">
        {hint ??
          `Lower finds more and reports more mistakes. Default ${defaultValue.toFixed(2)} from ai/configs/vision.yaml.`}
      </p>
    </div>
  );
}
