import crypto from 'crypto';
import { prisma } from '../lib/prisma';

/**
 * Generates a random alphanumeric string.
 * @param length Length of the random string (excluding prefix)
 * @returns Random alphanumeric string (uppercase)
 */
export const generateRandomString = (length: number): string => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Excluded confusing chars like I, 1, O, 0
  const randomBytes = crypto.randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[randomBytes[i] % chars.length];
  }
  return result;
};

/**
 * Generates a unique code by repeatedly generating and checking for collisions.
 * @param prefix The prefix for the code (e.g., 'PRD', 'VAR', 'SVM')
 * @param length The length of the random part (e.g., 6 or 8)
 * @param existsFn A callback function that returns true if the code exists in the DB
 * @returns A unique code
 */
export const generateUniqueCode = async (
  prefix: string,
  length: number,
  existsFn: (code: string) => Promise<boolean>
): Promise<string> => {
  let code = '';
  let exists = true;
  let attempts = 0;
  
  while (exists && attempts < 10) {
    code = `${prefix}-${generateRandomString(length)}`;
    exists = await existsFn(code);
    attempts++;
  }
  
  if (exists) {
    throw new Error(`Failed to generate a unique code for prefix ${prefix} after 10 attempts.`);
  }
  
  return code;
};

/**
 * Generates a sequential unique business code (e.g., PRD-000001) per client.
 */
export const generateSequentialCode = async (
  clientId: string,
  prefix: string, // e.g. "PRD", "VAR"
  entityType: string // e.g. "PRODUCT", "VARIANT"
): Promise<string> => {
  // Use Prisma atomic increment to avoid race conditions
  const sequence = await prisma.clientSequence.upsert({
    where: {
      clientId_entityType: {
        clientId,
        entityType
      }
    },
    update: {
      lastValue: {
        increment: 1
      }
    },
    create: {
      clientId,
      entityType,
      lastValue: 1
    }
  });

  const paddedValue = String(sequence.lastValue).padStart(6, '0');
  return `${prefix}-${paddedValue}`;
};

