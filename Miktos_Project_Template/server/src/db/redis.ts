import { createClient } from 'redis';
import { logger } from '../utils/logger';

// Create Redis client
export const redisClient = createClient({
  url: process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || '6379'}`,
  password: process.env.REDIS_PASSWORD,
  database: parseInt(process.env.REDIS_DB || '0'),
});

// Handle Redis connection events
redisClient.on('connect', () => {
  logger.info('Redis client connected');
});

redisClient.on('error', (error: Error) => {
  logger.error('Redis client error:', error);
});

redisClient.on('ready', () => {
  logger.info('Redis client ready');
});

// Connect to Redis
if (process.env.NODE_ENV !== 'test') {
  redisClient.connect().catch((error: Error) => {
    logger.error('Failed to connect to Redis:', error);
  });
}

export default redisClient;
