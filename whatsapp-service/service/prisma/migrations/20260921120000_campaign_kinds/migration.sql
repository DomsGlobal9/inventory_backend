-- Campaign messages (C8) and loyalty notices (C9) from a shop's number.
ALTER TYPE "MessageKind" ADD VALUE IF NOT EXISTS 'C8';
ALTER TYPE "MessageKind" ADD VALUE IF NOT EXISTS 'C9';
