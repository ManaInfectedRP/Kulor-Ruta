import { useRef } from 'react';

interface FieldProps {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  /** Multiplier from the stored value to what is displayed, e.g. 100 for percent. */
  display?: number;
  unit?: string;
  defaultValue?: number;
  onChange(value: number): void;
}

/** A number that can be typed or dragged sideways, and resets on double click. */
export function Field({ label, value, min = -Infinity, max = Infinity, step = 0.01, display = 1, unit = '', defaultValue, onChange }: FieldProps) {
  const drag = useRef<{ x: number; start: number } | null>(null);
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const decimals = step * display >= 1 ? 0 : step * display >= 0.1 ? 1 : 2;

  return (
    <div className="field">
      <span
        className="field-label"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, start: value };
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const delta = e.clientX - drag.current.x;
          onChange(clamp(drag.current.start + delta * step * (e.shiftKey ? 0.1 : 1)));
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onDoubleClick={() => defaultValue !== undefined && onChange(defaultValue)}
        title="Dra för att ändra, dubbelklicka för att återställa"
      >
        {label}
      </span>
      <input
        type="number"
        value={Number((value * display).toFixed(decimals))}
        step={step * display}
        onChange={(e) => {
          const parsed = Number(e.target.value);
          if (!Number.isNaN(parsed)) onChange(clamp(parsed / display));
        }}
      />
      {unit && <span className="field-unit">{unit}</span>}
    </div>
  );
}
