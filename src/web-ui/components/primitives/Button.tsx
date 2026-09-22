/**
 * components/primitives/Button.tsx — every clickable action in the console.
 *
 * Four variants, and they are a hierarchy, not a palette (design doc §1):
 *   ghost   — the default in dense chrome. No border, no fill. Header strips
 *             contain only these.
 *   subtle  — hairline border, no fill. The ordinary form button.
 *   primary — the ONE accent-filled action on a surface. If a screen has two,
 *             one of them is wrong.
 *   danger  — destructive. Outlined, never filled, and always paired with a
 *             confirm step at the call site (approve/emergency-stop/delete).
 *
 * Heights come from the density tokens, never from a literal px, so compact
 * mode moves every control together.
 *
 * Icon-only buttons are a TYPE-LEVEL contract: `iconOnly` requires
 * `aria-label`, because an icon with no text has no accessible name and the
 * operator's screen reader would announce "button". Use <IconButton> for the
 * common case.
 */
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import styles from './Button.module.css';

export type ButtonVariant = 'ghost' | 'subtle' | 'primary' | 'danger';
export type ButtonSize = 'sm' | 'md';

interface ButtonBase extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading glyph (16px icon from ./icons.tsx). */
  icon?: ReactNode;
  /** Trailing glyph — chevrons, external-link marks. */
  trailingIcon?: ReactNode;
  /** Stretch to the container's width (forms, sheets). */
  block?: boolean;
  /** In-flight: disables the control and announces aria-busy. */
  busy?: boolean;
  /** Escape hatch for layout-only classes from a parent module. */
  className?: string;
  /** React 19 takes `ref` as an ordinary prop — no forwardRef wrapper needed. */
  ref?: Ref<HTMLButtonElement>;
  children?: ReactNode;
}

export type ButtonProps = ButtonBase &
  (
    | {
        /** Square control with no visible label — an accessible name is mandatory. */
        iconOnly: true;
        'aria-label': string;
        children?: never;
      }
    | { iconOnly?: false }
  );

export function Button({
  variant = 'subtle',
  size = 'md',
  icon,
  trailingIcon,
  block = false,
  busy = false,
  iconOnly = false,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  const classes = [
    styles.button,
    styles[variant],
    styles[size],
    iconOnly ? styles.iconOnly : '',
    block ? styles.block : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type={type}
      className={classes}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {icon ? <span className={styles.glyph}>{icon}</span> : null}
      {iconOnly ? null : children}
      {trailingIcon ? <span className={styles.glyph}>{trailingIcon}</span> : null}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonBase, 'icon' | 'children' | 'trailingIcon'> {
  icon: ReactNode;
  /** Mandatory: the icon is the whole control. */
  'aria-label': string;
}

/** Square, label-less button. Same variants and sizing as <Button>. */
export function IconButton({ icon, ...rest }: IconButtonProps) {
  return <Button {...rest} iconOnly icon={icon} />;
}
