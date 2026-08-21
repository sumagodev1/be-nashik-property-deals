const { HttpError } = require('./errors');

// Cap so a pathological schema can't push a wall of text into a toast.
const MAX_MESSAGE_LEN = 300;

// Joi's DEFAULT pattern message embeds the raw regex —
//   "postingDate" with value "17-08-2026" fails to match the required
//   pattern: /^\d{4}-\d{2}-\d{2}$/
// — which is noise to an operator. Collapse just that tail. Messages written
// for the product ("Location is required.") never match this shape and pass
// through untouched.
function humanize(text) {
  return text.replace(
    / with value "[^"]*" fails to match the required pattern:.*$/,
    ' has an invalid format',
  );
}

/**
 * Build the user-facing `message` for a schema rejection.
 *
 * Every validation failure used to surface as a bare "Invalid request". The
 * per-field reasons were already in `details`, but the admin form renders
 * `error.message` in its toast and submit banner, so a missing Location and a
 * malformed date were indistinguishable to the operator — and to anyone
 * debugging from a screenshot.
 *
 * This promotes the first field-level message into `message`. It leaks nothing
 * new: `details` already carried every one of these strings to the client.
 *
 * Messages are de-duplicated first. A single field can raise the same text
 * more than once — `requiredWhenNotDraft` pairs `.required()` with
 * `.disallow('', null)`, so an empty Location yields "Location is required."
 * twice — and counting those as separate problems would print a misleading
 * "(+1 more)".
 */
function summarizeDetails(details) {
  const seen = new Set();
  for (const d of details) {
    const text = humanize(String((d && d.message) || '').trim());
    if (text) seen.add(text);
  }
  if (seen.size === 0) return 'Invalid request';
  const [first, ...rest] = seen;
  const message = rest.length > 0 ? `${first} (+${rest.length} more)` : first;
  return message.length > MAX_MESSAGE_LEN
    ? `${message.slice(0, MAX_MESSAGE_LEN - 1)}…`
    : message;
}

function validate(schema, source = 'body') {
  return (req, res, next) => {
    const { value, error } = schema.validate(req[source], {
      abortEarly: false,
      stripUnknown: true,
      convert: true,
    });
    if (error) {
      // `details` is unchanged — the frontend routes these per field to mark
      // the offending input. Only the summary `message` is new.
      const details = error.details.map((d) => ({ path: d.path.join('.'), message: d.message }));
      return next(new HttpError(400, 'VALIDATION_ERROR', summarizeDetails(details), details));
    }
    req[source] = value;
    next();
  };
}

module.exports = { validate, summarizeDetails };
