import config from '../config/env.js';

/**
 * Outbound mail for the platform-owner second factor.
 *
 * TransitSync is an on-premises / self-hosted console and historically shipped
 * with no mail server at all. Email one-time codes therefore degrade
 * gracefully:
 *
 *   * When `SMTP_HOST` is configured, mail is sent with `nodemailer`, which is
 *     imported lazily so a TOTP-only deployment never needs the dependency.
 *   * When it is not configured, the message (including the code) is written to
 *     the server console. That keeps the email factor usable on a single-operator
 *     box without pretending the mail was delivered somewhere it wasn't.
 */

let transporter;
let resolved = false;

async function getTransporter() {
  if (resolved) return transporter;
  resolved = true;
  if (!config.mail.enabled) return null;

  try {
    const module = await import('nodemailer');
    const nodemailer = module.default ?? module;
    transporter = nodemailer.createTransport({
      host: config.mail.host,
      port: config.mail.port,
      secure: config.mail.secure,
      auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined,
    });
  } catch (error) {
    process.stderr.write(
      `  [mail] SMTP_HOST is set but "nodemailer" could not be loaded (${error.message}). ` +
        'Install it with `npm install nodemailer`, or the code will be logged to this console.\n',
    );
    transporter = null;
  }
  return transporter;
}

/** True when a real SMTP transport is available, so the UI can offer email OTP. */
export function mailDeliverable() {
  return Boolean(config.mail.enabled);
}

/**
 * Send (or console-log) a message. Never throws for a delivery-constraint the
 * caller cannot fix: it resolves to `{ delivered, channel }` so the OTP flow can
 * report whether the code actually left the machine.
 */
export async function sendMail({ to, subject, text, html }) {
  const transport = await getTransporter();

  if (!transport) {
    process.stdout.write(
      `\n  [mail] SMTP not configured — code delivered to console instead of ${to}\n` +
        `  [mail] ${subject}\n` +
        text.split('\n').map((line) => `  [mail] ${line}`).join('\n') +
        '\n\n',
    );
    return { delivered: false, channel: 'console' };
  }

  await transport.sendMail({ from: config.mail.from, to, subject, text, html });
  return { delivered: true, channel: 'smtp' };
}

export default { sendMail, mailDeliverable };
