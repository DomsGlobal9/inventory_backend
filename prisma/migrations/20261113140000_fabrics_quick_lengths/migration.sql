-- The quick lengths on the online shop's length picker (13 Nov 2026, PLAN-fabrics decision 4), in centimetres:
-- 1 m, 2.5 m (a blouse), 5.5 m (a saree) unless the owner changes them. Additive.
ALTER TABLE "client_settings" ADD COLUMN IF NOT EXISTS "fabric_quick_lengths" INTEGER[] NOT NULL DEFAULT ARRAY[100, 250, 550];
