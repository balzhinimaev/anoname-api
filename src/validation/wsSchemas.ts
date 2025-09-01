import { z } from 'zod';

export const objectIdRegex = /^[a-f\d]{24}$/i;
export const objectIdSchema = z.string().regex(objectIdRegex, 'Invalid ObjectId');

const genderSchema = z.enum(['male', 'female']);
const desiredGenderSchema = z.array(z.enum(['male', 'female', 'any'])).min(1);

export const locationSchema = z.object({
  longitude: z.number().gte(-180).lte(180),
  latitude: z.number().gte(-90).lte(90),
});

export const searchCriteriaSchema = z.object({
  gender: genderSchema,
  age: z.number().int().min(18).max(100),
  rating: z.number().min(0).max(100).optional(),
  desiredGender: desiredGenderSchema,
  desiredAgeMin: z.number().int().min(18).max(100),
  desiredAgeMax: z.number().int().min(18).max(100),
  minAcceptableRating: z.number().min(-1).max(100).optional(),
  useGeolocation: z.boolean(),
  location: locationSchema.optional(),
  maxDistance: z.number().int().min(1).max(100).optional(),
}).refine((criteria: any) => criteria.desiredAgeMin <= criteria.desiredAgeMax, {
  message: 'desiredAgeMin must be <= desiredAgeMax'
}).refine((criteria: any) => !criteria.useGeolocation || !!criteria.location, {
  message: 'location required when useGeolocation is true'
});

export const chatMessageSchema = z.object({
  chatId: objectIdSchema,
  content: z.string().trim().min(1).max(2000),
  replyTo: objectIdSchema.optional(),
});

export const chatReadSchema = z.object({
  chatId: objectIdSchema,
  timestamp: z.union([z.date(), z.string()]),
});

export const chatEndSchema = z.object({
  chatId: objectIdSchema,
  reason: z.string().trim().max(200).optional(),
});

export const chatRateSchema = z.object({
  chatId: objectIdSchema,
  score: z.number().min(1).max(5),
  comment: z.string().trim().max(1000).optional(),
});


