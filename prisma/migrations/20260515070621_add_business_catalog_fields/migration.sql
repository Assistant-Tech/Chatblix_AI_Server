-- AlterTable
ALTER TABLE "BusinessProfile" ADD COLUMN     "current_offers" JSONB,
ADD COLUMN     "high_value_threshold" INTEGER,
ADD COLUMN     "locations" JSONB,
ADD COLUMN     "product_catalog" JSONB;
