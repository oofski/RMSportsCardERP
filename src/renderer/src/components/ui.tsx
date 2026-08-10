import type { ButtonHTMLAttributes, ReactNode, SelectHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { useEffect } from 'react'
import { Icon } from './Icon'
import { roleLabel, type Role } from '@shared/permissions'
import type { EmployeeStatus } from '@shared/types'

// ---------- Button ----------
interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  icon?: string
  loading?: boolean
  block?: boolean
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  loading,
  block,
  children,
  className = '',
  disabled,
  ...rest
}: BtnProps): JSX.Element {
  return (
    <button
      className={`btn btn-${variant} ${size === 'sm' ? 'btn-sm' : ''} ${
        block ? 'btn-block' : ''
      } ${className}`}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? (
        <span className={`spinner ${variant === 'primary' || variant === 'danger' ? '' : 'dark'}`} />
      ) : icon ? (
        <Icon name={icon} size={size === 'sm' ? 15 : 16} />
      ) : null}
      {children}
    </button>
  )
}

// ---------- Field wrapper ----------
export function Field({
  label,
  hint,
  error,
  children
}: {
  label?: string
  hint?: string
  error?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="field">
      {label && <label>{label}</label>}
      {children}
      {error ? <span className="error-text">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  )
}

export function Input({
  invalid,
  className = '',
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }): JSX.Element {
  // Same rule as Select below: `className` is destructured and MERGED. Left in
  // `...rest` it overwrote the base class, so every caller passing a modifier —
  // .po-qty-input, .po-price-input — silently lost the app's field styling and
  // rendered a native box. Those rules only ever set width and alignment; the
  // look they sit on top of comes from .input.
  return <input className={`input ${className} ${invalid ? 'field-error' : ''}`.trim()} {...rest} />
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>): JSX.Element {
  return <textarea className="textarea" {...props} />
}

export function Select({
  invalid,
  className = '',
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }): JSX.Element {
  // `className` must be destructured and MERGED, not left in `...rest` — spreading
  // it would overwrite the base class and strip the control of every app style,
  // leaving a raw browser dropdown in the middle of a styled form.
  return (
    <select className={`select ${className} ${invalid ? 'field-error' : ''}`.trim()} {...rest}>
      {children}
    </select>
  )
}

// ---------- Badges ----------
export function RoleBadge({ role }: { role: Role }): JSX.Element {
  return (
    <span className={`badge badge-${role}`}>
      <span className="dot" />
      {roleLabel(role)}
    </span>
  )
}

const STATUS_LABEL: Record<EmployeeStatus, string> = {
  invited: 'Invited',
  active: 'Active',
  disabled: 'Deactivated'
}

export function StatusBadge({ status }: { status: EmployeeStatus }): JSX.Element {
  return <span className={`badge badge-${status}`}>{STATUS_LABEL[status]}</span>
}

// ---------- Spinner ----------
export function CenterLoader(): JSX.Element {
  return (
    <div className="center-load">
      <span className="spinner dark" style={{ width: 26, height: 26 }} />
    </div>
  )
}

// ---------- Empty state ----------
export function EmptyState({
  icon = 'Info',
  title,
  message,
  action
}: {
  icon?: string
  title: string
  message?: string
  action?: ReactNode
}): JSX.Element {
  return (
    <div className="empty">
      <div className="empty-ico">
        <Icon name={icon} size={26} />
      </div>
      <h3>{title}</h3>
      {message && <p>{message}</p>}
      {action}
    </div>
  )
}

// ---------- Modal ----------
export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  wide
}: {
  title: string
  subtitle?: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className={`modal ${wide ? 'modal-lg' : ''}`}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="modal-head">
          <div>
            <h3>{title}</h3>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <Icon name="X" size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}

// ---------- Avatar ----------
export function Avatar({
  text,
  src,
  small
}: {
  text: string
  /** Profile-picture data URL; falls back to the initials when absent. */
  src?: string | null
  small?: boolean
}): JSX.Element {
  return (
    <div className={`avatar ${small ? 'avatar-sm' : ''}`}>
      {src ? <img className="avatar-img" src={src} alt="" /> : text}
    </div>
  )
}

// ---------- Checkbox ----------
export function Checkbox({
  checked,
  onChange,
  label,
  hint,
  disabled
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  /** Shown under the label. For a choice whose consequence is not obvious from
   *  its name — which is most choices worth putting a checkbox on. */
  hint?: string
  disabled?: boolean
}): JSX.Element {
  return (
    <label className={`checkbox${disabled ? ' is-disabled' : ''}${hint ? ' has-hint' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="box">
        <Icon name="Check" size={13} strokeWidth={3} />
      </span>
      <span className="checkbox-text">
        {label}
        {hint && <em>{hint}</em>}
      </span>
    </label>
  )
}
