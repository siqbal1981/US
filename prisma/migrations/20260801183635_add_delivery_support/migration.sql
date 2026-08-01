-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "deliveryAddress" TEXT,
ADD COLUMN     "deliveryAptSuite" TEXT,
ADD COLUMN     "deliveryInstructions" TEXT,
ADD COLUMN     "orderType" TEXT NOT NULL DEFAULT 'pickup';
