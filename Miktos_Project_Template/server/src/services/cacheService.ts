import { createClient } from 'redis';
import crypto from 'crypto';
import { logger } from '../utils/logger';

export interface CacheOptions {
  ttl?: number; // Time to live in seconds
  compress?: boolean; // Compress large values
  namespace?: string; // Cache namespace for organization
}

export interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  totalKeys: number;
  memoryUsage: number;
}

export class CacheService {
  private redis: any;
  private isConnected = false;
  private stats = {
    hits: 0,
    misses: 0
  };
  
  private readonly DEFAULT_TTL = 3600; // 1 hour
  private readonly MAX_KEY_LENGTH = 250;
  private readonly COMPRESSION_THRESHOLD = 1024; // 1KB

  constructor() {
    // Only initialize Redis if URL is provided
    if (process.env.REDIS_URL || process.env.REDIS_HOST) {
      this.initializeRedis().catch(error => {
        logger.error('Failed to initialize Redis:', error);
        this.isConnected = false;
      });
    } else {
      logger.warn('Redis not configured - caching disabled');
    }
  }

  private async initializeRedis() {
    try {
      // Create the Redis client
      this.redis = createClient({
        url: process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || '6379'}`,
        password: process.env.REDIS_PASSWORD,
        database: parseInt(process.env.REDIS_DB || '0'),
        socket: {
          reconnectStrategy: (retries: number) => {
            // Exponential backoff with max delay of 10 seconds
            const delay = Math.min(Math.pow(2, retries) * 100, 10000);
            logger.info(`Redis reconnect attempt ${retries} in ${delay}ms`);
            return delay;
          }
        }
      });

      // Only register event handlers if Redis client was created
      if (this.redis) {
        this.redis.on('connect', () => {
          logger.info('Redis cache service connected');
          this.isConnected = true;
        });

        this.redis.on('error', (error: Error) => {
          logger.error('Redis cache service error:', error);
          this.isConnected = false;
        });

        this.redis.on('ready', () => {
          logger.info('Redis cache service ready');
          this.isConnected = true;
        });

        this.redis.on('reconnecting', () => {
          logger.info('Redis cache service reconnecting...');
        });

        this.redis.on('end', () => {
          logger.info('Redis cache service connection closed');
          this.isConnected = false;
        });

        // Connect to Redis
        await this.redis.connect();
      } else {
        logger.error('Failed to create Redis client');
        this.isConnected = false;
      }
    } catch (error) {
      logger.error('Failed to initialize Redis:', error);
      this.isConnected = false;
      // Don't throw the error, we want to handle Redis failures gracefully
    }
  }

  /**
   * Generate a cache key from object data
   */
  private generateKey(data: any, namespace?: string): string {
    const hash = crypto
      .createHash('sha256')
      .update(JSON.stringify(data))
      .digest('hex')
      .substring(0, 32);
    
    const prefix = namespace ? `miktos:${namespace}:` : 'miktos:';
    const key = `${prefix}${hash}`;
    
    // Ensure key doesn't exceed Redis key length limits
    return key.length > this.MAX_KEY_LENGTH 
      ? key.substring(0, this.MAX_KEY_LENGTH)
      : key;
  }

  /**
   * Compress data if it exceeds threshold
   */
  private async compressData(data: string): Promise<string> {
    if (data.length > this.COMPRESSION_THRESHOLD) {
      const zlib = await import('zlib');
      return zlib.gzipSync(data).toString('base64');
    }
    return data;
  }

  /**
   * Decompress data if needed
   */
  private async decompressData(data: string, compressed: boolean): Promise<string> {
    if (compressed) {
      const zlib = await import('zlib');
      return zlib.gunzipSync(Buffer.from(data, 'base64')).toString();
    }
    return data;
  }

  /**
   * Set a value in cache
   */
  async set<T>(
    key: string | object, 
    value: T, 
    options: CacheOptions = {}
  ): Promise<boolean> {
    if (!this.isConnected || !this.redis) {
      logger.debug('Cache SET skipped - Redis not available');
      return false;
    }

    try {
      const cacheKey = typeof key === 'string' ? key : this.generateKey(key, options.namespace);
      const ttl = options.ttl || this.DEFAULT_TTL;
      
      const serializedValue = JSON.stringify(value);
      const shouldCompress = options.compress !== false && serializedValue.length > this.COMPRESSION_THRESHOLD;
      
      const finalValue = shouldCompress 
        ? await this.compressData(serializedValue)
        : serializedValue;

      // Store with metadata
      const cacheData = {
        value: finalValue,
        compressed: shouldCompress,
        timestamp: Date.now(),
        ttl: ttl
      };

      try {
        await this.redis.setEx(cacheKey, ttl, JSON.stringify(cacheData));
        logger.debug(`Cache SET: ${cacheKey} (TTL: ${ttl}s, Compressed: ${shouldCompress})`);
        return true;
      } catch (redisError) {
        logger.error(`Redis SET operation failed for key ${cacheKey}:`, redisError);
        return false;
      }
    } catch (error) {
      logger.error('Cache SET error:', error);
      return false;
    }
  }

  /**
   * Get a value from cache
   */
  async get<T>(
    key: string | object, 
    options: CacheOptions = {}
  ): Promise<T | null> {
    if (!this.isConnected || !this.redis) {
      this.stats.misses++;
      logger.debug('Cache GET skipped - Redis not available');
      return null;
    }

    try {
      const cacheKey = typeof key === 'string' ? key : this.generateKey(key, options.namespace);
      let cached;
      
      try {
        cached = await this.redis.get(cacheKey);
      } catch (redisError) {
        logger.error(`Redis GET operation failed for key ${cacheKey}:`, redisError);
        this.stats.misses++;
        return null;
      }
      
      if (!cached) {
        this.stats.misses++;
        logger.debug(`Cache MISS: ${cacheKey}`);
        return null;
      }

      this.stats.hits++;
      
      const cacheData = JSON.parse(cached);
      const decompressedValue = await this.decompressData(
        cacheData.value, 
        cacheData.compressed
      );
      
      logger.debug(`Cache HIT: ${cacheKey} (Age: ${Date.now() - cacheData.timestamp}ms)`);
      return JSON.parse(decompressedValue) as T;
    } catch (error) {
      this.stats.misses++;
      logger.error('Cache GET error:', error);
      return null;
    }
  }

  /**
   * Delete a key from cache
   */
  async delete(key: string | object, namespace?: string): Promise<boolean> {
    if (!this.isConnected || !this.redis) {
      logger.debug('Cache DELETE skipped - Redis not available');
      return false;
    }

    try {
      const cacheKey = typeof key === 'string' ? key : this.generateKey(key, namespace);
      const result = await this.redis.del(cacheKey);
      logger.debug(`Cache DELETE: ${cacheKey} (Existed: ${result > 0})`);
      return result > 0;
    } catch (error) {
      logger.error('Cache DELETE error:', error);
      return false;
    }
  }

  /**
   * Clear all cache keys with optional pattern
   */
  async clear(pattern?: string): Promise<number> {
    if (!this.isConnected || !this.redis) {
      logger.debug('Cache CLEAR skipped - Redis not available');
      return 0;
    }

    try {
      const searchPattern = pattern || 'miktos:*';
      const keys = await this.redis.keys(searchPattern);
      
      if (keys.length === 0) {
        return 0;
      }

      const result = await this.redis.del(keys);
      logger.info(`Cache CLEAR: ${result} keys deleted (Pattern: ${searchPattern})`);
      return result;
    } catch (error) {
      logger.error('Cache CLEAR error:', error);
      return 0;
    }
  }

  /**
   * Check if a key exists
   */
  async exists(key: string | object, namespace?: string): Promise<boolean> {
    if (!this.isConnected || !this.redis) {
      logger.debug('Cache EXISTS skipped - Redis not available');
      return false;
    }

    try {
      const cacheKey = typeof key === 'string' ? key : this.generateKey(key, namespace);
      const result = await this.redis.exists(cacheKey);
      return result === 1;
    } catch (error) {
      logger.error('Cache EXISTS error:', error);
      return false;
    }
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<CacheStats> {
    try {
      const info = await this.redis.info('memory');
      const memoryUsage = this.parseMemoryInfo(info);
      const totalKeys = await this.redis.dbSize();
      
      const hitRate = this.stats.hits + this.stats.misses > 0 
        ? this.stats.hits / (this.stats.hits + this.stats.misses)
        : 0;

      return {
        hits: this.stats.hits,
        misses: this.stats.misses,
        hitRate: parseFloat((hitRate * 100).toFixed(2)),
        totalKeys,
        memoryUsage
      };
    } catch (error) {
      logger.error('Cache STATS error:', error);
      return {
        hits: this.stats.hits,
        misses: this.stats.misses,
        hitRate: 0,
        totalKeys: 0,
        memoryUsage: 0
      };
    }
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = { hits: 0, misses: 0 };
    logger.info('Cache statistics reset');
  }

  /**
   * Parse memory usage from Redis INFO command
   */
  private parseMemoryInfo(info: string): number {
    const lines = info.split('\r\n');
    const memoryLine = lines.find(line => line.startsWith('used_memory:'));
    if (memoryLine) {
      return parseInt(memoryLine.split(':')[1]) || 0;
    }
    return 0;
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<{ status: 'healthy' | 'unhealthy' | 'disabled'; latency?: number }> {
    if (!this.redis) {
      return { status: 'disabled' };
    }

    try {
      const start = Date.now();
      await this.redis.ping();
      const latency = Date.now() - start;
      
      return { status: 'healthy', latency };
    } catch (error) {
      logger.error('Cache health check failed:', error);
      return { status: 'unhealthy' };
    }
  }

  /**
   * Close Redis connection
   */
  async close(): Promise<void> {
    try {
      await this.redis.quit();
      logger.info('Redis cache service disconnected');
    } catch (error) {
      logger.error('Error closing Redis connection:', error);
    }
  }
}

// Export singleton instance
export const cacheService = new CacheService();
