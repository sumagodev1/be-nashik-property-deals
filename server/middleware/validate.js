const { HttpError } = require('./errors');

function validate(schema, source = 'body') {
  return (req, res, next) => {
    const { value, error } = schema.validate(req[source], {
      abortEarly: false,
      stripUnknown: true,
      convert: true,
    });
    if (error) {
      const details = error.details.map((d) => ({ path: d.path.join('.'), message: d.message }));
      return next(new HttpError(400, 'VALIDATION_ERROR', 'Invalid request', details));
    }
    req[source] = value;
    next();
  };
}

module.exports = { validate };
