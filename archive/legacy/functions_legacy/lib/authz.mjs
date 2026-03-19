export function requireAuthIfProd(req, res, next) {
  const env = process.env.NODE_ENV || 'development';
  if (env !== 'production') return next();
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return res.status(401).json({ ok:false, error:'unauthorized' });
  // TODO: verify token with Firebase Admin auth if you want user-level control
  return next();
}
