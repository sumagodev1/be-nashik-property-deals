/**
 * SMS sender (stub).
 *
 * The project does NOT have an SMS gateway wired up. This module exists so
 * the seller register/login OTP flows can declare intent ("send via SMS")
 * without forcing every caller to know whether SMS is actually configured.
 *
 * Behavior:
 *   - In development (NODE_ENV !== 'production'): the OTP service already
 *     logs the code to stdout and returns it on the start-response as
 *     `devOtpCode`. So `trySendSms` here is a no-op success in dev.
 *   - In production: no provider is wired, so this returns { ok: false }
 *     with a clear marker. Wire your provider (Twilio, MSG91, AWS SNS,
 *     Fast2SMS, etc.) at the marked TODO before going live.
 *
 * Keep the failure soft (return false / never throw) so OTP issuance still
 * succeeds and the row is persisted — the user can request a resend, and
 * the dev-OTP path still works during integration testing.
 */

// eslint-disable-next-line no-unused-vars
async function trySendSms({ mobileNumber, body }) {
  if (process.env.NODE_ENV !== 'production') {
    // Dev mode: caller already logged + returned `devOtpCode`. No real SMS needed.
    return { ok: true, dev: true };
  }

  // TODO(SMS-gateway): wire a real provider here.
  // Example with Twilio (uncomment + install `twilio`):
  //
  //   const twilio = require('twilio');
  //   const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  //   await client.messages.create({
  //     to: mobileNumber.startsWith('+') ? mobileNumber : `+91${mobileNumber}`,
  //     from: process.env.TWILIO_FROM,
  //     body,
  //   });
  //   return { ok: true };
  //
  // Until then, log + return false. The OTP row is still persisted so a
  // human-in-the-loop (or the email fallback below, if you choose to wire
  // one) can complete delivery.
  // eslint-disable-next-line no-console
  console.warn(
    `[sms] No SMS gateway configured. Skipping send for ${mobileNumber}. ` +
      'Wire a provider in server/services/sms/sender.js.',
  );
  return { ok: false, reason: 'NO_GATEWAY' };
}

module.exports = { trySendSms };
