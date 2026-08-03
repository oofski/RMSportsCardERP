import type { ComposedEmail, Employee } from '@shared/types'
import { roleLabel } from '@shared/permissions'
import { APP_NAME, COMPANY_NAME, DOWNLOAD_URL, SUPPORT_EMAIL, WEB_APP_URL } from '@shared/config'

/**
 * Build the invite email an administrator sends to a new employee. The email
 * explains how to download / access the app and how to sign in for the first
 * time with their temporary password.
 *
 * Returns the plaintext parts plus a ready-to-open `mailto:` URL so the
 * renderer can preview the message and open it in the user's mail client.
 */
export function composeInviteEmail(
  employee: Employee,
  temporaryPassword: string | null,
  senderName: string
): ComposedEmail {
  const to = employee.email
  const subject = `Welcome to the ${APP_NAME}`

  const lines: string[] = [
    `Hi ${employee.firstName},`,
    '',
    `You've been added to the ${APP_NAME} at ${COMPANY_NAME} as ${roleLabel(
      employee.role
    )}${employee.title ? ` (${employee.title})` : ''}.`,
    '',
    'GETTING IN',
    '----------',
    `1. Download the Windows app:`,
    `   ${DOWNLOAD_URL}`,
    `   (On Mac? Use the web version: ${WEB_APP_URL})`,
    '',
    '2. Open the app and sign in with:',
    `   Company ID: ${employee.companyId}`,
    `   Email:      ${employee.email}`
  ]

  if (temporaryPassword) {
    lines.push(
      `   Temporary password: ${temporaryPassword}`,
      '',
      // Only when a change is actually going to be demanded. A packing bench is
      // shared and is never prompted, so telling its account to expect a prompt
      // would be describing a screen it will not see.
      employee.mustChangePassword
        ? "3. You'll be asked to set your own password the first time you sign in."
        : '3. Sign in with that password — you will not be asked to change it.'
    )
  } else {
    lines.push('', '3. Use the password you were given to sign in.')
  }

  lines.push(
    '',
    `Questions? Reach out to ${senderName} or email ${SUPPORT_EMAIL}.`,
    '',
    `— ${COMPANY_NAME}`
  )

  const body = lines.join('\n')
  const mailtoUrl = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(
    subject
  )}&body=${encodeURIComponent(body)}`

  return { to, subject, body, mailtoUrl }
}
