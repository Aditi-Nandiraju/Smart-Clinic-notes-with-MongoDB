import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { User, AuditLog } from '../models/index.js';

export function signToken(user) {
  return jwt.sign({ sub: String(user._id), role: user.role, name: user.name }, config.jwtSecret, { expiresIn: '12h' });
}

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Sign in required' });
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    const user = await User.findById(payload.sub).lean();
    if (!user || !user.active) return res.status(401).json({ error: 'Account disabled' });
    req.user = user;
    return next();
  } catch {
    return res.status(401).json({ error: 'Session expired, please sign in again' });
  }
}

export const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user?.role)) return res.status(403).json({ error: `This action needs the ${roles.join(' or ')} role` });
  return next();
};

/** Write one entry to the time-series audit log. Never blocks the request. */
export function audit(req, action, target, detail) {
  AuditLog.create({
    at: new Date(),
    meta: { userId: req.user?._id, role: req.user?.role, name: req.user?.name },
    action,
    target,
    detail,
  }).catch((e) => console.error('[audit]', e.message));
}
