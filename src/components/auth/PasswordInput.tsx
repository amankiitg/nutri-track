/**
 * A password field with a way to read what was typed.
 *
 * One component rather than a toggle wound into each form, because there are four password fields
 * across two screens and a fifth copy of this markup is how one of them ends up behaving
 * differently. The reveal state is **owned by the caller**, not by this component: the reset page
 * has two fields and one decision, so lifting the state is what makes them agree.
 *
 * Three details that are easy to get wrong and invisible when wrong:
 *
 *   - The button is `type="button"`. Inside a form a bare `<button>` submits it, so pressing the
 *     eye would attempt a sign-in instead of revealing the field.
 *   - `onMouseDown` is prevented so the press does not take focus out of the field it is revealing,
 *     and the caret is put back afterwards. A reveal that loses your place is worse than none.
 *   - `autoComplete` is the caller's, untouched. Password managers still need to see
 *     `current-password` and `new-password` on the field they fill.
 */
import { useEffect, useRef, type InputHTMLAttributes } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  /** Whether the text is readable, owned by the caller so two fields can share one decision. */
  visible: boolean;
  onToggle: () => void;
};

export function PasswordInput({ visible, onToggle, className, ...props }: PasswordInputProps) {
  const field = useRef<HTMLInputElement>(null);
  /** Where the caret was when the reveal was pressed, restored once React has finished. */
  const caret = useRef<{ start: number | null; end: number | null } | null>(null);

  function toggle(): void {
    const input = field.current;
    caret.current =
      input === null ? null : { start: input.selectionStart, end: input.selectionEnd };
    onToggle();
  }

  useEffect(() => {
    const saved = caret.current;
    if (saved === null) return;
    caret.current = null;

    // On the next task, not in this effect. Measured in Chromium: React rewrites the input's value
    // after the commit that changes `type`, and that write drops the caret to 0 *after* every
    // effect has run, so restoring inside the effect is silently undone. One timeout is enough and
    // is not a retry loop: the page was settled, caret still at 0, long after this fires.
    const timer = setTimeout(() => {
      const input = field.current;
      if (input === null) return;
      input.focus();
      if (saved.start !== null && saved.end !== null) {
        input.setSelectionRange(saved.start, saved.end);
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [visible]);

  return (
    <div className="relative">
      <Input
        {...props}
        ref={field}
        type={visible ? "text" : "password"}
        className={cn("pr-11", className)}
      />
      <button
        type="button"
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        // Keeps the press from taking focus out of the field it is revealing.
        onMouseDown={(event) => event.preventDefault()}
        onClick={toggle}
        className="absolute inset-y-0 right-0 grid w-11 place-items-center rounded-r-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {visible ? (
          <EyeOff className="size-4" aria-hidden="true" />
        ) : (
          <Eye className="size-4" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}
