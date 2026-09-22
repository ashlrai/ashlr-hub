/**
 * components/primitives/Slider.tsx — a continuous value (accent hue,
 * saturation, a budget). Native <input type="range"> so the platform's
 * keyboard model (arrows, Home/End, PageUp/PageDown) comes for free; the
 * track and thumb are restyled to the token system.
 *
 * `valueLabel` renders the number in the display face next to the control.
 * It is presentational: the control's own accessible value is carried by
 * aria-valuetext when a unit would otherwise be lost ("245" -> "245 degrees").
 */
import { useId, type InputHTMLAttributes, type ReactNode } from 'react';
import styles from './Slider.module.css';

export interface SliderProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'className' | 'value'> {
  label?: ReactNode;
  value: number;
  min?: number;
  max?: number;
  /** Rendered to the right of the track, in the display face. */
  valueLabel?: ReactNode;
  /** Spoken value, when the raw number needs a unit. */
  valueText?: string;
  /** Paint the filled portion of the track (hue sliders want a gradient instead). */
  trackImage?: string;
  className?: string;
}

export function Slider({
  label,
  value,
  min = 0,
  max = 100,
  valueLabel,
  valueText,
  trackImage,
  className,
  id,
  ...rest
}: SliderProps) {
  const generatedId = useId();
  const sliderId = id ?? generatedId;
  const span = Math.max(1, max - min);
  const percent = Math.round(((value - min) / span) * 100);

  return (
    <div className={`${styles.field} ${className ?? ''}`}>
      {label ? (
        <label className={styles.label} htmlFor={sliderId}>
          {label}
        </label>
      ) : null}
      <div className={styles.row}>
        <input
          {...rest}
          id={sliderId}
          type="range"
          className={styles.input}
          value={value}
          min={min}
          max={max}
          aria-valuetext={valueText}
          style={
            {
              '--slider-fill': `${percent}%`,
              ...(trackImage ? { '--slider-track-image': trackImage } : {}),
            } as React.CSSProperties
          }
          data-custom-track={trackImage ? 'true' : undefined}
        />
        {valueLabel !== undefined ? <span className={styles.value}>{valueLabel}</span> : null}
      </div>
    </div>
  );
}
