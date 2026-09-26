import type { ReactNode } from "react";

const WORK_STEPS = [
  { label: "Create profile", title: "Create or recover your profile", hint: "Tell task owners what you do and where you work." },
  { label: "Link payout wallet", title: "Link your payout wallet", hint: "Create or recover your profile first, then link the Sui wallet that will receive your payments." },
  { label: "Verify identity", title: "Complete World Selfie Check", hint: "Link your payout wallet, then take a selfie in the World ID app. No Orb visit is needed." },
  { label: "Find and do work", title: "Find a task and follow it to payment", hint: "Complete your profile, wallet, and identity steps before applying for work." },
];

export function WorkIntro() {
  return <section className="directory-hero directory-hero--compact">
    <p className="eyebrow">Worker workspace · earn with your skills</p>
    <h1>Set up once. <span>Work with clarity.</span></h1>
    <p>Follow four steps to create your worker profile, link a payout wallet, verify your identity, and start applying for tasks.</p>
    <small>World Selfie Check checks liveness and facial similarity. Task owners review your delivery, and confirmed USDC payments appear in your earnings.</small>
  </section>;
}

export function WorkSetup({ currentStep, children }: { currentStep: number | null; children: ReactNode }) {
  return <section className="hiring-setup work-setup" aria-label="Worker setup">
    <ol className="hiring-progress" aria-label="Worker setup progress">
      {WORK_STEPS.map(({ label }, index) => {
        const step = index + 1;
        const complete = currentStep !== null && step < currentStep;
        return <li key={label} className={`hiring-progress__item${complete ? " hiring-progress__item--complete" : step === currentStep ? " hiring-progress__item--current" : ""}`} aria-label={`${label}${complete ? " — complete" : ""}`} aria-current={step === currentStep ? "step" : undefined}>
          <span aria-hidden="true">{complete ? "✓" : step}</span><small>{label}</small>
        </li>;
      })}
    </ol>
    <ol className="hiring-steps">{children}</ol>
  </section>;
}

export function WorkStep({ step, currentStep, children }: { step: 1 | 2 | 3 | 4; currentStep: number | null; children?: ReactNode }) {
  const content = WORK_STEPS[step - 1];
  const state = currentStep === step ? "current" : currentStep !== null && step < currentStep ? "complete" : "locked";
  return <li className={`hiring-step hiring-step--${state}`} aria-current={currentStep === step ? "step" : undefined}>
    <div className="hiring-step__number" aria-hidden="true">{step}</div>
    <div className="hiring-step__body">
      <p className="eyebrow">Step {step}</p><h2>{content.title}</h2>
      {children ?? <p>{content.hint}</p>}
    </div>
  </li>;
}
