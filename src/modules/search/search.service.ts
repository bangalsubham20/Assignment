import { db } from '../../infrastructure/database/db.service';
import { redisService } from '../../infrastructure/redis/redis.service';

export interface SearchDoctorsQuery {
  specialty?: string;
  maxFee?: number;
  minRating?: number;
  limit?: number;
  offset?: number;
}

export class SearchService {
  async searchDoctors(query: SearchDoctorsQuery) {
    const limit = query.limit || 20;
    const offset = query.offset || 0;
    const cacheKey = `search:spec_${query.specialty || 'all'}:fee_${query.maxFee || 'all'}:rat_${query.minRating || 'all'}:l_${limit}:o_${offset}`;

    // 1. Check Redis Cache
    const cached = await redisService.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    // 2. Query Database with filters
    let sql = `
      SELECT 
        d.user_id as id,
        d.specialty,
        d.experience_years as "experienceYears",
        d.consultation_fee as "consultationFee",
        d.bio,
        d.rating,
        d.total_reviews as "totalReviews",
        d.is_verified as "isVerified",
        p.first_name as "firstName",
        p.last_name as "lastName",
        p.avatar_url as "avatarUrl",
        p.gender
      FROM doctors d
      JOIN profiles p ON d.user_id = p.user_id
      WHERE d.is_verified = TRUE
    `;
    const params: any[] = [];
    let paramIdx = 1;

    if (query.specialty) {
      sql += ` AND UPPER(d.specialty) = UPPER($${paramIdx++})`;
      params.push(query.specialty);
    }

    if (query.maxFee !== undefined) {
      sql += ` AND d.consultation_fee <= $${paramIdx++}`;
      params.push(query.maxFee);
    }

    if (query.minRating !== undefined) {
      sql += ` AND d.rating >= $${paramIdx++}`;
      params.push(query.minRating);
    }

    sql += ` ORDER BY d.rating DESC, d.experience_years DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
    params.push(limit, offset);

    const res = await db.query(sql, params);

    const result = {
      data: res.rows,
      count: res.rowCount,
      limit,
      offset,
    };

    // Cache result in Redis for 60 seconds
    await redisService.set(cacheKey, JSON.stringify(result), 60);

    return result;
  }
}

export const searchService = new SearchService();
