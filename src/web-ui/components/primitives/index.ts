/**
 * components/primitives/index.ts — one import site for the design system's
 * controls. Direct module imports keep working (nothing was moved); this
 * barrel exists so a section can write
 *
 *   import { Button, Segmented, Meter } from '../../components/primitives/index.js';
 *
 * instead of five lines that each have to be right about the file name.
 *
 * Icons stay in their own module (`./icons.js`): they are ~30 named exports
 * and pulling them into every barrel consumer is noise.
 */
export { Button, IconButton } from './Button.js';
export type { ButtonProps, ButtonSize, ButtonVariant, IconButtonProps } from './Button.js';

export { Dialog } from './Dialog.js';
export type { DialogProps } from './Dialog.js';

export { EmptyState } from './EmptyState.js';
export type { EmptyStateProps } from './EmptyState.js';

export { Epistemic, EpistemicBadge, isKnown } from './Epistemic.js';
export type { EpistemicProps } from './Epistemic.js';

export { FOCUSABLE_SELECTOR, focusableWithin, useFocusTrap } from './focus-trap.js';

export { Input } from './Input.js';
export type { InputProps } from './Input.js';

export { Meter, toneForPercent } from './Meter.js';
export type { MeterProps, MeterTone } from './Meter.js';

export { RefreshIndicator } from './RefreshIndicator.js';

export { Segmented } from './Segmented.js';
export type { SegmentedOption, SegmentedProps } from './Segmented.js';

export { Select } from './Select.js';
export type { SelectProps } from './Select.js';

export { Sheet } from './Sheet.js';
export type { SheetProps } from './Sheet.js';

export { SkeletonCard, SkeletonCardGrid, SkeletonLine, SkeletonRow } from './Skeleton.js';

export { PhaseDot, StatusBadge, statusToTone } from './StatusBadge.js';
export type { StatusBadgeProps, Tone } from './StatusBadge.js';

export { Slider } from './Slider.js';
export type { SliderProps } from './Slider.js';

export { Switch } from './Switch.js';
export type { SwitchProps } from './Switch.js';

export { EngineMarker, Tag, engineColor } from './Tag.js';
export type { TagProps } from './Tag.js';

export { ToastProvider, useToast } from './Toast.js';
export type { ToastTone } from './Toast.js';

export { Tooltip } from './Tooltip.js';
export type { TooltipPlacement, TooltipProps } from './Tooltip.js';
