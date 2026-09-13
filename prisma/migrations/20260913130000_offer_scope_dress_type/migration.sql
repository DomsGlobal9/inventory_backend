-- An offer can apply to a type of garment -- Saree, Lehenga, Anarkali -- matched against
-- Product.dressType. The department (Product.category: WOMEN, MEN, KIDS, UNISEX) could not say
-- "20% off sarees", which is the offer shops most often want to write.
ALTER TYPE "OfferScope" ADD VALUE 'DRESS_TYPE';
