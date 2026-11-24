'use strict';

// Parse + coerce input with a zod schema; unknown keys are dropped (schemas are non-passthrough).
const validate = (schema, source = 'body') => (req, res, next) => {
  const result = schema.safeParse(req[source]);
  if (!result.success) return next(result.error);
  req.valid = { ...(req.valid || {}), [source]: result.data };
  return next();
};

module.exports = { validate };
