export interface LinkedFlowStep {
  title: string;
  to?: string;
  hint?: string;
}

export function enumerateLinkedFlowSteps(steps: LinkedFlowStep[]) {
  return steps
    .map((step, index) => ({ ...step, number: index + 1 }))
    .filter((step): step is LinkedFlowStep & { number: number; to: string } => Boolean(step.to));
}
