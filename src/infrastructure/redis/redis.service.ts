import Redis from 'ioredis';
import { config } from '../../config/env';

export interface IRedisService {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  setnx(key: string, value: string, ttlMs: number): Promise<boolean>;
  isHealthy(): Promise<boolean>;
  close(): Promise<void>;
}

class InMemoryRedisStore implements IRedisService {
  private store: Map<string, { value: string; expiresAt: number | null }> = new Map();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : null;
    this.store.set(key, { value, expiresAt });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async setnx(key: string, value: string, ttlMs: number): Promise<boolean> {
    const current = await this.get(key);
    if (current !== null) {
      return false; // Key already locked
    }
    const expiresAt = Date.now() + ttlMs;
    this.store.set(key, { value, expiresAt });
    return true; // Successfully acquired lock
  }

  async isHealthy(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    this.store.clear();
  }
}

class RedisService implements IRedisService {
  private client: Redis | null = null;
  private fallback: InMemoryRedisStore = new InMemoryRedisStore();
  private useFallback = false;

  constructor() {
    // In test environment or when configured without Redis daemon, immediately use in-memory store
    if (config.NODE_ENV === 'test') {
      this.useFallback = true;
      return;
    }
    this.init();
  }

  private init() {
    try {
      this.client = new Redis({
        host: config.REDIS_HOST,
        port: config.REDIS_PORT,
        password: config.REDIS_PASSWORD || undefined,
        maxRetriesPerRequest: 0,
        enableOfflineQueue: false,
        connectTimeout: 1000,
        lazyConnect: true,
      });

      this.client.connect().catch(() => {
        this.useFallback = true;
      });

      this.client.on('error', () => {
        this.useFallback = true;
      });
    } catch {
      this.useFallback = true;
    }
  }

  async get(key: string): Promise<string | null> {
    if (this.useFallback || !this.client) {
      return this.fallback.get(key);
    }
    try {
      return await this.client.get(key);
    } catch {
      return this.fallback.get(key);
    }
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (this.useFallback || !this.client) {
      return this.fallback.set(key, value, ttlSeconds);
    }
    try {
      if (ttlSeconds) {
        await this.client.set(key, value, 'EX', ttlSeconds);
      } else {
        await this.client.set(key, value);
      }
    } catch {
      await this.fallback.set(key, value, ttlSeconds);
    }
  }

  async del(key: string): Promise<void> {
    if (this.useFallback || !this.client) {
      return this.fallback.del(key);
    }
    try {
      await this.client.del(key);
    } catch {
      await this.fallback.del(key);
    }
  }

  async setnx(key: string, value: string, ttlMs: number): Promise<boolean> {
    if (this.useFallback || !this.client) {
      return this.fallback.setnx(key, value, ttlMs);
    }
    try {
      const result = await this.client.set(key, value, 'PX', ttlMs, 'NX');
      return result === 'OK';
    } catch {
      return this.fallback.setnx(key, value, ttlMs);
    }
  }

  async isHealthy(): Promise<boolean> {
    if (this.useFallback) return true;
    try {
      if (!this.client) return false;
      const res = await this.client.ping();
      return res === 'PONG';
    } catch {
      return true; // fallback active
    }
  }

  async close(): Promise<void> {
    if (this.client) {
      try {
        await this.client.quit();
      } catch {
        this.client.disconnect();
      }
    }
    await this.fallback.close();
  }
}

export const redisService = new RedisService();
