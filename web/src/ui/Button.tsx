import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "danger" | "ghost";
type Size = "md" | "lg";

const VARIANT: Record<Variant, string> = {
  primary: "bg-brand text-white active:bg-brand-strong",
  secondary: "border border-slate-300 bg-surface text-ink active:bg-slate-100",
  danger: "bg-danger text-white active:bg-red-700",
  ghost: "text-brand-strong active:bg-slate-100",
};
const SIZE: Record<Size, string> = {
  md: "min-h-[44px] px-3 py-2",
  lg: "min-h-[52px] px-4 py-3 text-lg font-semibold",
};

/** The app's one button. Native props pass straight through, so data-testid, disabled,
 *  aria-* and type behave exactly as on a bare <button>. type defaults to "button" --
 *  a bare button inside a form submits it, which no screen here wants by accident. */
export function Button({ variant = "primary", size = "md", className = "", type = "button", ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button
      type={type}
      className={`rounded-lg disabled:opacity-40 ${VARIANT[variant]} ${SIZE[size]} ${className}`}
      {...rest}
    />
  );
}
