/**
 * Product switches (as opposed to the test switches in `e2e-support.ts`): a user, an admin or a
 * support engineer may set these, in ANY build flavor, so they are read from the environment.
 *
 *   ARAGON_DESKTOP_ATTACHMENTS=0   hide attachments (paste / drop / pick / @ references) entirely.
 *                                  History that already carries pictures is still shown.
 *
 * Only the exact string '0' turns a switch off. '', 'false', 'off' and a typo leave the feature ON:
 * a guess about intent would silently remove a feature from someone who did not ask for that.
 */

export function attachmentsEnabledFrom(env: NodeJS.ProcessEnv): boolean {
  return env.ARAGON_DESKTOP_ATTACHMENTS !== '0';
}
