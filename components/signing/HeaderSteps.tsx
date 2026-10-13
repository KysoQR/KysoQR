/**
 * Compact horizontal step indicator sized to sit inline in the header row
 * (see Header.tsx's `centerContent`), replacing the old full-width
 * `StepProgress` card that used to render as its own block below the header
 * — moved here to reclaim vertical space so the signing wizard's step-1
 * screen fits one viewport without scrolling (see SigningWizard.tsx).
 *
 * The current step stands out (bold label, haloed circle) so it reads at a
 * glance which step the user is on. Every label shows from `xl` up; between
 * `lg` and `xl` only the current one does (the others keep their circle,
 * with the name as tooltip) so four steps fit beside the toolbar.
 */
export function HeaderSteps({
  steps,
  currentStepIndex,
}: {
  steps: readonly { key: string; label: string }[];
  currentStepIndex: number;
}) {
  return (
    <ol className="flex items-center">
      {steps.map((step, idx) => {
        const isCompleted = idx < currentStepIndex;
        const isCurrent = idx === currentStepIndex;
        return (
          <li key={step.key} className="flex items-center">
            {idx > 0 && (
              <span
                className={`mx-2 h-px w-6 ${idx <= currentStepIndex ? 'bg-primary' : 'bg-border-subtle'}`}
              />
            )}
            <span
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs ${
                isCompleted
                  ? 'bg-primary font-semibold text-white'
                  : isCurrent
                    ? 'border-2 border-primary bg-white font-bold text-primary ring-4 ring-primary/15'
                    : 'border border-gray-300 bg-white font-semibold text-text-muted'
              }`}
              title={step.label}
              aria-label={step.label}
              {...(isCurrent ? { 'aria-current': 'step' } : {})}
            >
              {isCompleted ? '✓' : idx + 1}
            </span>
            <span
              className={`ml-2 whitespace-nowrap text-sm ${
                isCurrent
                  ? 'font-bold text-primary-strong'
                  : `hidden xl:inline ${isCompleted ? 'font-medium text-primary-strong' : 'font-medium text-text-muted'}`
              }`}
            >
              {step.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
