/**
 * Form primitives.
 *
 * Every control is uncontrolled-friendly and reports through a single
 * `handleChange('field', value)` callback, which keeps page-level form state
 * flat (`{ fullName: '…', routeId: '3' }`) and makes it trivial to feed Zod
 * `details` straight back onto individual inputs via `fieldErrors`.
 */

import { forwardRef, useId } from 'react';

import { Icon } from './Icon.jsx';

export function Field({ label, hint, error, required, children, htmlFor, className = '', counter }) {
  return (
    <div className={className}>
      {label ? (
        <label className="label" htmlFor={htmlFor}>
          {label}
          {required ? <span className="ml-0.5 text-red-400">*</span> : null}
        </label>
      ) : null}

      {children}

      <div className="mt-1 flex min-h-[1rem] items-start justify-between gap-2">
        {error ? (
          <p className="flex items-center gap-1 text-[0.7rem] font-medium text-red-400">
            <Icon name="info" className="h-3 w-3 shrink-0" />
            {error}
          </p>
        ) : hint ? (
          <p className="text-[0.7rem] text-mist-500">{hint}</p>
        ) : null}
        {counter ? <p className="tabular shrink-0 text-[0.68rem] text-mist-500">{counter}</p> : null}
      </div>
    </div>
  );
}

export const Input = forwardRef(function Input(
  { label, hint, error, required, icon, suffix, className = '', wrapperClass = '', ...props },
  ref,
) {
  const id = useId();
  const fieldId = props.id ?? id;

  return (
    <Field label={label} hint={hint} error={error} required={required} htmlFor={fieldId} className={wrapperClass}>
      <div className="relative">
        {icon ? (
          <Icon
            name={icon}
            className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-mist-500"
          />
        ) : null}
        <input
          ref={ref}
          id={fieldId}
          aria-invalid={error ? 'true' : undefined}
          className={`field ${icon ? 'pl-8.5' : ''} ${suffix ? 'pr-9' : ''} ${error ? '!border-red-500/70' : ''} ${className}`}
          {...props}
        />
        {suffix ? (
          <span className="absolute top-1/2 right-2.5 -translate-y-1/2 text-mist-500">{suffix}</span>
        ) : null}
      </div>
    </Field>
  );
});

export function Select({ label, hint, error, required, options = [], placeholder, children, className = '', wrapperClass = '', ...props }) {
  const id = useId();
  const fieldId = props.id ?? id;

  return (
    <Field label={label} hint={hint} error={error} required={required} htmlFor={fieldId} className={wrapperClass}>
      <select
        id={fieldId}
        aria-invalid={error ? 'true' : undefined}
        className={`field appearance-none bg-[length:14px] bg-[right_0.6rem_center] bg-no-repeat pr-8 ${error ? '!border-red-500/70' : ''} ${className}`}
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='2.5' stroke-linecap='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")",
        }}
        {...props}
      >
        {placeholder ? <option value="">{placeholder}</option> : null}
        {options.map((option) => {
          const value = typeof option === 'string' ? option : option.value;
          const text = typeof option === 'string' ? option : option.label;
          return (
            <option key={value} value={value}>
              {text}
            </option>
          );
        })}
        {children}
      </select>
    </Field>
  );
}

export const Textarea = forwardRef(function Textarea(
  { label, hint, error, required, maxLength, value = '', className = '', wrapperClass = '', ...props },
  ref,
) {
  const id = useId();
  const fieldId = props.id ?? id;

  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      required={required}
      htmlFor={fieldId}
      className={wrapperClass}
      counter={maxLength ? `${String(value ?? '').length}/${maxLength}` : undefined}
    >
      <textarea
        ref={ref}
        id={fieldId}
        value={value}
        maxLength={maxLength}
        aria-invalid={error ? 'true' : undefined}
        className={`field resize-y leading-relaxed ${error ? '!border-red-500/70' : ''} ${className}`}
        {...props}
      />
    </Field>
  );
});

export function Checkbox({ label, hint, error, className = '', ...props }) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={props.id ?? id} className="flex cursor-pointer items-start gap-2.5">
        <input
          id={props.id ?? id}
          type="checkbox"
          className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded border-[var(--border-subtle)] bg-[var(--surface-sunken)] accent-sky-500"
          {...props}
        />
        <span className="min-w-0">
          <span className="block text-[0.83rem] font-medium text-mist-200">{label}</span>
          {hint ? <span className="block text-[0.7rem] text-mist-500">{hint}</span> : null}
        </span>
      </label>
      {error ? <p className="mt-1 text-[0.7rem] font-medium text-red-400">{error}</p> : null}
    </div>
  );
}

/**
 * Accessible on/off switch.
 *
 * Built from a native checkbox with `role="switch"` so the control is a single
 * label target, keyboard-operable and screen-reader friendly.
 *
 * The visible track and thumb are siblings of the input — required for
 * Tailwind's `peer-*` variants, which use the general-sibling combinator. The
 * previous markup nested an absolutely-positioned thumb inside a <button>;
 * because a button carries `text-align: center`, the thumb's static position
 * was the middle of the track, so the `translate-x-*` transforms pushed it off
 * the right edge (checked) and off-centre (unchecked). A checkbox has no such
 * UA text alignment, and `left-0.5` + `translate-x-full` keeps the 5-unit thumb
 * inset by exactly 2px on both sides of the 11-unit track, in both states.
 */
export function Toggle({ checked, onChange, label, hint, disabled, id }) {
  const generatedId = useId();
  const inputId = id ?? generatedId;

  return (
    <label
      htmlFor={inputId}
      className={`flex items-start gap-2.5 ${disabled ? 'cursor-not-allowed opacity-55' : 'cursor-pointer'}`}
    >
      <span className="relative inline-flex h-6 w-11 shrink-0">
        <input
          id={inputId}
          type="checkbox"
          role="switch"
          aria-checked={checked}
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          className="peer sr-only"
        />
        {/*
         * Track. `peer-checked:` recolours it, `peer-focus-visible:` moves the
         * focus ring here because the real input is visually hidden.
         */}
        <span
          aria-hidden="true"
          className="absolute inset-0 rounded-full bg-ink-600 transition-colors duration-200 peer-checked:bg-sky-500 peer-focus-visible:ring-2 peer-focus-visible:ring-sky-400/60 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-[var(--surface-sunken)]"
        />
        {/*
         * Thumb. Anchored top-left and translated exactly its own width when
         * on, so it never overhangs the track.
         */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 peer-checked:translate-x-full"
        />
      </span>
      <span className="min-w-0">
        <span className="block text-[0.83rem] font-medium text-mist-200">{label}</span>
        {hint ? <span className="block text-[0.7rem] text-mist-500">{hint}</span> : null}
      </span>
    </label>
  );
}

/**
 * Group of radio buttons rendered as segmented chips — used for severity and
 * status pickers where a native select would hide the options.
 */
export function SegmentedControl({ label, value, onChange, options, className = '', wrapperClass = '' }) {
  return (
    <Field label={label} className={wrapperClass}>
      <div className={`flex flex-wrap gap-1.5 ${className}`} role="radiogroup" aria-label={label}>
        {options.map((option) => {
          const optionValue = typeof option === 'string' ? option : option.value;
          const optionLabel = typeof option === 'string' ? option : option.label;
          const active = value === optionValue;

          return (
            <button
              key={optionValue}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(optionValue)}
              className={`chip ring-1 transition ${
                active
                  ? 'bg-sky-500/18 text-sky-300 ring-sky-500/45'
                  : 'bg-transparent text-mist-400 ring-[var(--border-subtle)] hover:text-mist-200'
              }`}
            >
              {optionLabel}
            </button>
          );
        })}
      </div>
    </Field>
  );
}

/** Banner shown above a form when a save failed. */
export function FormError({ error, onDismiss }) {
  if (!error) return null;

  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-xl border border-red-500/35 bg-red-500/10 px-3.5 py-2.5 text-[0.8rem] text-red-300"
    >
      <Icon name="alert" className="mt-px h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{error.message}</p>
        {error.details?.length > 1 ? (
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[0.74rem] opacity-90">
            {error.details.slice(0, 6).map((detail, index) => (
              <li key={index}>
                <span className="font-medium">{detail.field}</span>: {detail.message}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {onDismiss ? (
        <button type="button" onClick={onDismiss} className="shrink-0 opacity-60 hover:opacity-100" aria-label="Dismiss">
          <Icon name="close" className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}

/** Filter bar wrapper — search + selects laid out responsively. */
export function FilterBar({ children, className = '', onClear, clearLabel = 'Clear filters' }) {
  return (
    <div className={`flex flex-wrap items-end gap-2.5 ${className}`}>
      {children}
      {onClear ? (
        <button type="button" className="btn btn-ghost" onClick={onClear}>
          <Icon name="close" className="h-3.5 w-3.5" />
          {clearLabel}
        </button>
      ) : null}
    </div>
  );
}

/** Grid used by every create/edit dialog so fields line up consistently. */
export function FormGrid({ children, columns = 2, className = '' }) {
  const cols = { 1: 'sm:grid-cols-1', 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-3' }[columns] ?? 'sm:grid-cols-2';
  return <div className={`grid grid-cols-1 gap-x-4 ${cols} ${className}`}>{children}</div>;
}