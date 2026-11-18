import { Select } from "@base-ui/react/select";
import type { AnyFieldApi } from "@tanstack/react-form";
import type { ReactNode } from "react";
import { Icon } from "./icons.tsx";

/** One labelled input bound to a TanStack Form field, with its validation message. */
export function TextField({ field, label, type = "text", placeholder, autoFocus }: { field: AnyFieldApi; label: string; type?: string; placeholder?: string; autoFocus?: boolean }) {
  const errors = field.state.meta.isTouched ? field.state.meta.errors : [];
  return (
    <label className="field">
      {label}
      <input className="input" type={type} placeholder={placeholder} autoFocus={autoFocus} name={field.name} value={field.state.value as string} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} aria-invalid={errors.length > 0} />
      {errors.length > 0 && <em role="alert">{errors.map((e) => (typeof e === "string" ? e : (e as { message?: string })?.message)).join(", ")}</em>}
    </label>
  );
}

/** A Base UI select styled as an inline choice inside a sentence, or as a plain chip. */
export function Choice<T extends string>({ value, onChange, options, className = "wpick", label }: { value: T; onChange: (value: T) => void; options: readonly (readonly [T, ReactNode])[]; className?: string; label: string }) {
  return (
    <Select.Root value={value} onValueChange={(next) => next !== null && onChange(next as T)} items={options.map(([key, text]) => ({ value: key, label: text }))}>
      <Select.Trigger className={className} aria-label={label}>
        <Select.Value />
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner sideOffset={6} style={{ zIndex: 60 }} alignItemWithTrigger={false}>
          <Select.Popup className="pop" style={{ position: "static", minWidth: 200, maxHeight: 320, overflow: "auto" }}>
            {options.map(([key, text]) => (
              <Select.Item key={key} value={key} className="pitem">
                <Select.ItemIndicator style={{ display: "contents" }}><Icon name="check" size={12} /></Select.ItemIndicator>
                <Select.ItemText>{text}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}
