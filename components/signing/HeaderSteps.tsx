/**
 * Compact horizontal step indicator sized to sit inline in the header row
 * (see Header.tsx's `centerContent`), replacing the old full-width
 * `StepProgress` card that used to render as its own block below the header
 * — moved here to reclaim vertical space so the signing wizard's step-1
 * screen fits one viewport without scrolling (see SigningWizard.tsx).
 *
 * The current step stands out (bold label, haloed circle) so it reads at a
 * glance which step the user is on. Kept small (20px circles, `text-xs`)
 * so the row stays thin and the PDF workspace below gets the height.
 * Every label shows from `xl` up; between
 * `lg` and `xl` only the current one does (the others keep their circle,
 * with the name as tooltip) so four steps fit beside the toolbar.
 * `allLabelsFrom="md"` shows every label from `md` up instead (the home
 * page, which has the room).
 */
const ALL_LABELS_CLASS = { md: 'hidden md:inline', xl: 'hidden xl:inline' } as const;

export function HeaderSteps({
  steps,
  currentStepIndex,
  allLabelsFrom = 'xl',
}: {
  steps: readonly { key: string; label: string }[];
  currentStepIndex: number;
  allLabelsFrom?: keyof typeof ALL_LABELS_CLASS;
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
                className={`mx-1.5 h-px w-4 ${idx <= currentStepIndex ? 'bg-primary' : 'bg-border-subtle'}`}
              />
            )}
            <span
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] ${
                isCompleted
                  ? 'bg-primary font-semibold text-white'
                  : isCurrent
                    ? 'border-2 border-primary bg-white font-bold text-primary ring-2 ring-primary/15'
                    : 'border border-gray-300 bg-white font-semibold text-text-muted'
              }`}
              title={step.label}
              aria-label={step.label}
              {...(isCurrent ? { 'aria-current': 'step' } : {})}
            >
              {isCompleted ? '✓' : idx + 1}
            </span>
            <span
              className={`ml-1.5 whitespace-nowrap text-xs ${
                isCurrent
                  ? 'font-bold text-primary-strong'
                  : `${ALL_LABELS_CLASS[allLabelsFrom]} ${isCompleted ? 'font-medium text-primary-strong' : 'font-medium text-text-muted'}`
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
