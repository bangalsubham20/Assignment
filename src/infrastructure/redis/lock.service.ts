import { redisService } from './redis.service';
import { v4 as uuidv4 } from 'uuid';

export interface ILock {
  resource: string;
  token: string;
  ttlMs: number;
}

export class DistributedLockService {
  /**
   * Attempt to acquire a distributed lock on a resource with a timeout
   * @param resource e.g. "slot_lock:b329a43a-..."
   * @param ttlMs Time-to-live in milliseconds
   * @returns ILock if acquired, null if locked by another concurrent process
   */
  async acquireLock(resource: string, ttlMs: number = 5000): Promise<ILock | null> {
    const lockToken = uuidv4();
    const lockKey = `lock:${resource}`;

    const acquired = await redisService.setnx(lockKey, lockToken, ttlMs);
    if (!acquired) {
      return null;
    }

    return {
      resource,
      token: lockToken,
      ttlMs,
    };
  }

  /**
   * Release the distributed lock safely ensuring we only delete our own token
   */
  async releaseLock(lock: ILock): Promise<boolean> {
    const lockKey = `lock:${lock.resource}`;
    const currentVal = await redisService.get(lockKey);

    if (currentVal === lock.token) {
      await redisService.del(lockKey);
      return true;
    }

    // Token mismatched or expired
    return false;
  }
}

export const lockService = new DistributedLockService();
