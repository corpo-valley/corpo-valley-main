import { Request, Response, NextFunction } from 'express';
import { getUserTier } from '../services/keto';
import { renderError } from '../templates';

export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.portalSession) {
    res.status(401).send(renderError('Unauthorized', 'You must be logged in.'));
    return;
  }

  try {
    const tier = await getUserTier(req.portalSession.id);
    if (tier !== 'ADMIN') {
      res.status(403).send(renderError('Forbidden', 'Admin access required.'));
      return;
    }
    next();
  } catch (err: any) {
    console.error('Admin check failed:', err.message);
    res.status(500).send(renderError('Error', 'Failed to verify admin access.'));
  }
}
