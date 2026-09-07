import { validResourceNativeProcessDiagnostic, type ResourceNativeProcessDiagnostic } from '../../../core/resources/native-diagnostics.js';
import type { ResourceTaskReceipt } from '../../../core/resources/pool-runtime.js';
import styles from './ResourcePoolView.module.css';

interface Diagnosis { label: string; explanation: string; nextCheck: string }

// Reasons are bounded runtime classifications, not provider output. Never echo an unknown reason.
const DIAGNOSES: Record<string, Diagnosis> = {
  'worker-cli-upgrade-required': {
    label: 'Native CLI upgrade required',
    explanation: 'The configured model was rejected because the native CLI needs an upgrade.',
    nextCheck: 'Select or update a compatible CLI, then recheck the enrolled account and quota before a new attempt. The console does not change the CLI or model automatically.',
  },
  'worker-exit-failed': {
    label: 'Native process exited unsuccessfully',
    explanation: 'The native process exited unsuccessfully. Its exit status alone does not identify an authentication, quota, or provider fault.',
    nextCheck: 'Check the configured launcher and CLI/model compatibility, then verify the enrolled account and current quota using private local evidence.',
  },
  'worker-process-failed': {
    label: 'Native process could not complete',
    explanation: 'The subprocess runner reported a process error. A normal exit status may not be available.',
    nextCheck: 'Check that the configured launcher and native executable are available in the selected workspace and account environment.',
  },
  'worker-terminal-failed': {
    label: 'Worker reported an unsuccessful result',
    explanation: 'The native event stream reported an unsuccessful result. A zero exit code does not override that result.',
    nextCheck: 'Review the task scope and CLI/model compatibility using private local evidence. Do not treat partial output as accepted work.',
  },
  'worker-terminal-missing': {
    label: 'Complete terminal event missing',
    explanation: 'The native event stream did not contain the required complete terminal result.',
    nextCheck: 'Check that the configured CLI version and launcher produce the supported event format. Partial output is not completion evidence.',
  },
  'worker-invalid-events': {
    label: 'Native events could not be validated',
    explanation: 'The captured native event stream could not be validated.',
    nextCheck: 'Check CLI/launcher compatibility with the supported event format before submitting another task.',
  },
  'worker-conversation-reset': {
    label: 'Native conversation reset',
    explanation: 'The native event stream reported a conversation reset; the task result could not be accepted as a single complete response.',
    nextCheck: 'Check the task scope and native session behavior before a deliberate new attempt.',
  },
  'worker-result-origin-unexpected': {
    label: 'Unexpected native result origin',
    explanation: 'The native terminal result did not have the supported request origin.',
    nextCheck: 'Check the CLI version and launcher event contract. Do not substitute another session’s result.',
  },
  'worker-output-truncated': {
    label: 'Native capture was truncated',
    explanation: 'The bounded native capture was incomplete, so it cannot establish a complete result.',
    nextCheck: 'Reduce the task or response scope and check the configured output budget before considering a new attempt.',
  },
  'worker-termination-uncertain': {
    label: 'Native cleanup is unconfirmed',
    explanation: 'The runner could not confirm process cleanup. This receipt continues occupying shared capacity.',
    nextCheck: 'Stop the affected pool and reconcile the owned process and private receipt evidence before resuming. Do not delete the ledger to release capacity.',
  },
  'worker-cancelled': {
    label: 'Worker invocation cancelled',
    explanation: 'The invocation was cancelled; this is not proof of a provider fault.',
    nextCheck: 'Check the recorded task and cancellation intent before deciding whether another attempt is needed.',
  },
  'worker-timed-out': {
    label: 'Worker deadline reached',
    explanation: 'The invocation exceeded its configured deadline. A timeout is not a measured provider exit code.',
    nextCheck: 'Review task scope and the configured deadline, and confirm cleanup and fresh capacity evidence before considering a new attempt.',
  },
  'worker-output-token-limit': {
    label: 'Reported output exceeded the task limit',
    explanation: 'Reported output tokens exceeded this task’s limit. This check is not a measurement of the account’s total usage.',
    nextCheck: 'Reduce the requested response scope or deliberately review the task budget; the failed response is not accepted work.',
  },
  'worker-output-missing': {
    label: 'Worker response was empty',
    explanation: 'The worker did not provide a nonempty response.',
    nextCheck: 'Check the task prompt and worker response contract before submitting another task.',
  },
  'worker-tool-calls-not-allowed': {
    label: 'Local worker requested unsupported tool calls',
    explanation: 'This local worker path does not execute tool calls returned by the model.',
    nextCheck: 'Use a response-only task compatible with the configured local worker. No returned tool call was accepted as execution evidence.',
  },
  'worker-transport-failed': {
    label: 'Local worker transport failed',
    explanation: 'The configured local worker request could not complete.',
    nextCheck: 'Check the selected local model and endpoint availability, then refresh local health evidence before another task.',
  },
  'worker-invalid-configuration': {
    label: 'Worker configuration was rejected',
    explanation: 'Worker configuration validation failed before execution could proceed.',
    nextCheck: 'Check the explicit pool, binding, workspace, and task settings. Do not infer that a native process started.',
  },
};

const TASK_REASONS: Record<string, string> = {
  'worker-completed': 'Worker completed', 'task-completed': 'Task completed', 'task-reserved': 'Task reserved',
  'not-yet-dispatched': 'Not yet dispatched', 'dispatch-requested': 'Dispatch requested',
  'no-eligible-capacity': 'No eligible capacity', 'queued-task-cancelled': 'Queued task cancelled',
  'cancellation-requested': 'Cancellation requested', 'task-identity-conflict': 'Task identity conflict',
  'previous-dispatch-unresolved': 'Previous dispatch unresolved', 'settlement-unavailable': 'Settlement unavailable',
  'dispatch-settlement-unavailable': 'Dispatch settlement unavailable',
};

export function taskReasonLabel(reason: string | null | undefined): string {
  if (!reason) return 'Not yet dispatched';
  if (Object.hasOwn(DIAGNOSES, reason)) return DIAGNOSES[reason]!.label;
  return Object.hasOwn(TASK_REASONS, reason) ? TASK_REASONS[reason]! : 'Unrecognized recorded reason';
}

export function TaskDiagnosis({ receipt }: { receipt?: ResourceTaskReceipt }) {
  if (!receipt || !['failed', 'timed-out', 'cancelled', 'uncertain'].includes(receipt.status)) return null;
  const diagnosis = Object.hasOwn(DIAGNOSES, receipt.reason) ? DIAGNOSES[receipt.reason] : undefined;
  const native: ResourceNativeProcessDiagnostic | null = validResourceNativeProcessDiagnostic(receipt.nativeProcess)
    ? receipt.nativeProcess : null;
  return <section className={styles.outputSection} aria-label="Receipt diagnosis">
    <h3>Receipt diagnosis</h3>
    <p className={styles.caption}>Based on this recorded receipt, not the supervisor’s current state. Process facts do not establish accepted work.</p>
    <p>{diagnosis?.explanation ?? 'The receipt records an unsuccessful or unresolved outcome without a recognized diagnosis. No provider cause can be inferred.'}</p>
    <dl className={styles.facts}>
      <div><dt>Recorded reason</dt><dd>{taskReasonLabel(receipt.reason)}</dd></div>
      {native ? <>
        <div><dt>Native exit code</dt><dd>{native.exitCode ?? 'Not reported'}</dd></div>
        <div><dt>Native signal</dt><dd>{native.signal ?? 'Not reported'}</dd></div>
        <div><dt>Stderr captured</dt><dd>{native.stderrPresent ? 'Yes' : 'No'}. Captured stderr may include runner notices; presence or absence does not identify a vendor error.</dd></div>
        <div><dt>Capture truncated</dt><dd>{native.outputTruncated ? 'Yes' : 'No'}. Bounded stdout or stderr capture; text is not included.</dd></div>
      </> : null}
    </dl>
    {!native ? <p className={styles.muted}>{receipt.nativeProcess === undefined
      ? 'Native process details were not recorded. Legacy receipts, local workers, and tasks ending before native invocation returns can omit them.'
      : 'Native process details are unavailable or unsupported.'} Missing details are not a zero exit code or proof that stderr was empty.</p> : null}
    <div><h3>Next check</h3><p>{diagnosis?.nextCheck ?? 'Check the recorded worker, pool configuration, and private local evidence before deciding on another task.'}</p></div>
    {receipt.status === 'uncertain' && receipt.reason !== 'worker-termination-uncertain'
      ? <p className={styles.warning}>This unresolved receipt still occupies capacity. Stop and reconcile the affected pool before resuming; do not delete its ledger.</p> : null}
    <p className={styles.caption}>No automatic retry. A deliberate new attempt requires a new task ID, fresh admission checks, and a new reservation.</p>
  </section>;
}
